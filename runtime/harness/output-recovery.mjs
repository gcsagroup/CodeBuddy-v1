import { z } from 'zod';
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session';

export const OUTPUT_LIMIT = 'OUTPUT_LIMIT_REACHED';
export const isOutputLimitFailure = code => code === OUTPUT_LIMIT || code === 'OUTPUT_TRUNCATED' || code === 'OUTPUT_LENGTH_STOP';
export const OUTPUT_RECOVERY_KEY = 'codebuddyOutputRecovery';
export const OUTPUT_RECOVERY_LIMIT = 2;
const recordType = 'plugin:codebuddy/output-recovery';
const lengthFailures = new Set([OUTPUT_LIMIT, 'OUTPUT_TRUNCATED', 'OUTPUT_LENGTH_STOP', 'LOCAL_OUTPUT_BUDGET_EXHAUSTED']);
const budgetSchema = z.object({
  requestedTokens: z.number().int().positive(), effectiveTokens: z.number().int().nonnegative(),
  capacityTokens: z.number().int().positive(), contextLimit: z.number().int().positive(),
  source: z.enum(['configured', 'service', 'catalog', 'fallback']),
});
const legacyRetrySchema = z.object({ turn: z.number().int().nonnegative(), attempt: z.literal(1),
  strategy: z.enum(['compact', 'smaller-steps']), budget: budgetSchema });
const retrySchema = legacyRetrySchema.extend({ version: z.literal(2), step: z.number().int().positive(),
  attempt: z.number().int().min(1).max(OUTPUT_RECOVERY_LIMIT) });
const initialState = (header = {}, inheritedEventCount = 0) => ({ turn: -1, step: 0, failures: 0, stepFailures: 0,
  attempts: 0, stepAttempts: 0, maxAttempts: OUTPUT_RECOVERY_LIMIT,
  parentSession: header.parentSession ?? null, inheritedEventCount, inputStarted: false,
  budget: null, limited: false, retryPending: false });

// Fold native attempts and an ignorable plugin record. Reload never grants a
// fresh recovery allowance, and no second task/retry journal is introduced.
export const outputRecoveryProjection = {
  key: OUTPUT_RECOVERY_KEY, stateVersion: 2,
  stateSchema: z.object({ turn: z.number().int(), step: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(), stepFailures: z.number().int().nonnegative(),
    attempts: z.number().int().min(0).max(OUTPUT_RECOVERY_LIMIT), stepAttempts: z.number().int().min(0).max(1),
    maxAttempts: z.union([z.literal(1), z.literal(OUTPUT_RECOVERY_LIMIT)]),
    parentSession: z.string().nullable(), inheritedEventCount: z.number().int().nonnegative(), inputStarted: z.boolean(),
    budget: budgetSchema.nullable(), limited: z.boolean(), retryPending: z.boolean() }),
  init: initialState,
  apply(state, event) {
    if (event.seq < state.inheritedEventCount) return state;
    if (event.type === 'turn/start') return { ...state, turn: event.data.turn, step: 0,
      stepAttempts: 0, stepFailures: 0, inputStarted: false, retryPending: false, limited: false };
    if (event.type === 'step/start' && event.data.turn === state.turn && event.data.step > state.step)
      return { ...state, step: event.data.step, stepAttempts: 0, stepFailures: 0, retryPending: false };
    if (event.type === 'user/message' && state.step === 1 && !state.inputStarted) {
      const source = event.data.source;
      // Automatic child reports may open another native turn in the same user
      // request. Only a new admitted input (not a later-step steer) renews it.
      if (source?.kind === 'user' || source?.kind === 'schedule' ||
          source?.kind === 'agent-message' && state.parentSession !== null && source.senderSessionId === state.parentSession)
        return { ...initialState({ parentSession: state.parentSession }, state.inheritedEventCount),
          turn: state.turn, step: state.step, inputStarted: true };
    }
    if (event.type === 'turn/end' && event.data.turn === state.turn) {
      const reason = event.data.reason;
      return { ...state, retryPending: false, limited: reason.kind === 'max-tokens' || reason.kind === 'error' && lengthFailures.has(reason.error.code) };
    }
    if (event.type === 'assistant/message' && event.data.turn === state.turn)
      return state.retryPending ? { ...state, retryPending: false } : state;
    if (event.type === 'assistant/attempt' && event.data.turn === state.turn) {
      const finish = event.data.stream.findLast(item => item.type === 'chunk' && item.chunk.type === 'finish');
      if (lengthFailures.has(finish?.chunk.reason.failure?.code)) return { ...state, retryPending: false,
        failures: state.failures + 1, stepFailures: state.stepFailures + 1 };
    }
    const record = pluginRecordOf(event);
    if (record?.type !== recordType) return state;
    if (record.data?.version === undefined) {
      const legacy = legacyRetrySchema.safeParse(record.data);
      // An old in-flight turn keeps its original one-recovery allowance. A
      // version-2 projection replays native history instead of refreshing it.
      return legacy.success && legacy.data.turn === state.turn
        ? { ...state, attempts: 1, stepAttempts: 1, maxAttempts: 1, budget: legacy.data.budget,
          retryPending: legacy.data.strategy === 'smaller-steps' } : state;
    }
    const parsed = retrySchema.safeParse(record.data);
    return parsed.success && parsed.data.turn === state.turn && parsed.data.step === state.step &&
      parsed.data.attempt === state.attempts + 1 && parsed.data.attempt <= state.maxAttempts && !state.stepAttempts
      ? { ...state, attempts: parsed.data.attempt, stepAttempts: 1, budget: parsed.data.budget,
        retryPending: parsed.data.strategy === 'smaller-steps' } : state;
  },
};

/** Use the native request-error retry; never replay a committed tool action. */
export function installOutputRecovery(ctx, { budgetSource = () => 'fallback', publish = () => {} } = {}) {
  const releaseProjection = ctx.sessionProjections.register(outputRecoveryProjection);
  const stateOf = agent => ctx.sessionProjections.stateOf(agent.session, OUTPUT_RECOVERY_KEY);
  // Generic developer messages are filtered by native tool-update projection.
  // Registered context is refreshed for the same-step retry and projected by
  // the native runtime-context owner into the actual request envelope.
  const releaseContext = ctx.systemPrompt.context({
    name: 'codebuddy:output-recovery', order: 130, required: true, interpolate: false,
    text: ({ agent }) => agent && stateOf(agent)?.retryPending
      ? 'This instruction applies only to retrying the generation that just failed, not to later user tasks. The previous generation reached its single-response output limit. No tool call from that failed generation was executed. Continue the original user task from confirmed results. Regenerate only the unfinished step, using smaller tool calls and shorter file-writing chunks. Do not repeat completed operations, change the requested functionality, or treat this recovery attempt as task completion.'
      : '',
  });
  const available = ({ agent, turn, step, fit }) => {
    const state = stateOf(agent);
    if (!state || state.turn !== turn || state.step !== step || state.limited ||
        state.stepAttempts || state.stepFailures > 1 || state.attempts >= state.maxAttempts) return false;
    const pending = ctx.sessionProjections.stateOf(agent.session, 'modelSelection')?.pending;
    return !pending || pending.provider === fit.provider && pending.model === fit.model;
  };
  const releaseAvailable = ctx.on('codebuddy/output-recovery-available', input => ({ allowed: available(input) }));
  const start = ({ agent, turn, step, fit, strategy }) => {
    if (!available({ agent, turn, step, fit })) return false;
    const state = stateOf(agent);
    const budget = {
      requestedTokens: fit.desiredMaxTokens, effectiveTokens: fit.effectiveMaxTokens,
      capacityTokens: fit.modelMaxTokens, contextLimit: fit.contextWindow,
      source: fit.explicitMaxTokens ? 'configured' : budgetSource(fit.provider),
    };
    // Validate our versioned record before committing. It is never model input.
    const data = retrySchema.parse({ version: 2, turn, step, attempt: state.attempts + 1, strategy, budget });
    appendPluginRecord(agent.session, recordType, data);
    publish({ type: 'output_recovery', sessionId: agent.id, ...data, maxAutomaticAttempts: state.maxAttempts });
    return true;
  };
  const releaseStart = ctx.on('codebuddy/output-recovery-started', input => ({ allowed: start(input) }));
  const releaseStatus = ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'running' || !stateOf(agent)?.limited) return;
    const pending = [...agent.inbox.nextStep, ...agent.inbox.nextTurn];
    if (pending.length && pending.every(message => message.source?.kind === 'subagent-settled' ||
        message.source?.kind === 'agent-message' && message.source.senderSessionId !== agent.session.header.parentSession))
      // Native running admission precedes turn/start and inbox claim. Keep the
      // original notice pending until the next explicit human prompt.
      agent.cancel({ kind: 'hook', reason: 'codebuddy:output-limit-notice' }, { keepInbox: true });
  });
  const releaseError = ctx.on('agent/request-error', async ({ agent, turn, step, failure, signal }, next) => {
    if (failure.code !== OUTPUT_LIMIT || signal.aborted) return next();
    const recovery = ctx.llm.requestFitRecovery?.(failure);
    const state = stateOf(agent);
    if (!recovery || state?.stepFailures !== 1) return next();
    const fit = recovery.fit;
    // Keep the same budget and frozen route. Known capacities were already
    // applied before dispatch; guessing a larger cap here cannot fix a gateway.
    if (fit.effectiveMaxTokens < fit.desiredMaxTokens || fit.available < fit.minimumMaxTokens) return next();
    signal.throwIfAborted();
    if (!start({ agent, turn, step, fit, strategy: 'smaller-steps' })) return next();
    signal.throwIfAborted();
    return { kind: 'retry' };
  });
  return { stateOf, dispose() { releaseError(); releaseStart(); releaseAvailable(); releaseStatus(); releaseContext(); releaseProjection(); } };
}
