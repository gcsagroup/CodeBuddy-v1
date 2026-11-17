import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm';
import { publicFailure } from '../error-presentation.mjs';

// Native end events retain their private error string. Carry only the safe
// projection until that exact transaction's end is published by the driver.
const failureDiagnostics = new WeakMap();
export function takeCompactionFailureDiagnostic(session, compactionId) {
  const entry = failureDiagnostics.get(session);
  failureDiagnostics.delete(session);
  return entry?.compactionId === compactionId ? entry.diagnostic : undefined;
}

const pressureSpecs = new WeakMap();
export function clearPressureSpec(session) { pressureSpecs.delete(session); }

export function pressureThresholdFor(session, contextWindow) {
  const spec = pressureSpecs.get(session);
  const route = session.requestHeader()?.config;
  return spec && spec.contextWindow === contextWindow && sameTarget(spec.target, route)
    ? spec.thresholdTokens : undefined;
}

class UnchangedCheckpoint extends Error {}
const summaryRoute = (agent, config, target) => {
  const route = target ?? agent.session.requestHeader()?.config ?? agent.options;
  return JSON.stringify([route?.provider, route?.model, config]);
};
export const SUMMARY_RETRY_POLICY = Object.freeze({ maxAutomaticRetries: 2, delayMs: 30_000, minGrowthTokens: 8192 });
function rememberSummaryFailure(engine, agent, error) {
  if (!engine.summaryFailures || engine.summaryFailures.get(agent)?.error === error) return;
  let tokens;
  try { tokens = engine.ctx.tokenMeter?.measure(agent.session).totalTokens; }
  catch { /* Recovery diagnostics must not replace the original summary failure. */ }
  engine.summaryFailures.set(agent, { route: summaryRoute(agent, engine.config, engine.pressureAttempts?.get(agent)?.target), error,
    tokens, retryAt: performance.now() + SUMMARY_RETRY_POLICY.delayMs });
  engine.ctx.logger?.warn('compaction summary backoff: ' + JSON.stringify({ code: fallbackFailure(error, backoffCodes)?.code,
    delayMs: SUMMARY_RETRY_POLICY.delayMs, minGrowthTokens: SUMMARY_RETRY_POLICY.minGrowthTokens,
    maxAutomaticRetries: SUMMARY_RETRY_POLICY.maxAutomaticRetries }));
}
const checkpointFailureCodes = new Set(['MAX_TOKENS', 'OUTPUT_TRUNCATED', 'OUTPUT_LENGTH_STOP', 'OUTPUT_LIMIT_REACHED',
  'EMPTY_RESPONSE', 'COMPACTION_EMPTY_SUMMARY', 'COMPACTION_NOT_SMALLER']);
const connectionFailureCodes = new Set(['TRANSPORT', 'TIMEOUT', 'SERVER']);
const backoffCodes = new Set([...checkpointFailureCodes, ...connectionFailureCodes]);
const fallbackCodes = new Set([...checkpointFailureCodes, 'COMPACTION_OUTPUT_BUDGET_EXHAUSTED', 'CONTEXT_WINDOW_EXCEEDED',
  'TRANSPORT', 'TIMEOUT', 'SERVER', 'RATE_LIMIT', 'QUOTA', 'AUTH', 'INVALID_CREDENTIAL', 'INVALID_REQUEST',
  'NO_ADAPTER', 'MODEL_NOT_FOUND', 'UNSUPPORTED_CONTENT', 'UNSUPPORTED_OPTION', 'INVALID_OUTPUT_BUDGET', 'PI_AI_ERROR']);
function fallbackFailure(error, codes = fallbackCodes) {
  const seen = new Set();
  for (let cause = error; cause && !seen.has(cause); cause = cause.cause) {
    if (codes.has(cause.code)) return cause;
    seen.add(cause);
  }
}
const sameTarget = (a, b) => a?.provider === b?.provider && a?.model === b?.model;
function idleTarget(ctx, agent) {
  return ctx.sessionProjections.stateOf(agent.session, 'modelSelection')?.pending ?? agent.session.requestHeader()?.config ?? agent.options;
}
async function activateFallback(engine, agent, target, error, signal, failedTarget) {
  signal?.throwIfAborted();
  if (!fallbackFailure(error)) return;
  const policy = engine.config.modelPolicies.find(rule => sameTarget(rule, target));
  const rule = engine.fallbackPolicies?.find(rule => sameTarget(rule.source, target));
  if (!rule) return;
  const cached = engine.fallbackTargets.get(agent);
  const state = cached && sameTarget(cached.source, target) ? cached : { source: target, index: -1, attempted: new Set() };
  const configuredProvider = policy?.summarizationProvider ?? engine.config.summarizationProvider;
  const primary = configuredProvider ? { provider: configuredProvider, model: policy?.summarizationModel ?? engine.config.summarizationModel } : target;
  const failed = failedTarget ?? (state.provider ? state : primary);
  const previous = { provider: failed.provider, model: failed.model };
  state.attempted.add(JSON.stringify([previous.provider, previous.model]));
  engine.fallbackTargets.set(agent, state);
  let preparationError;
  for (let index = state.index + 1; index < rule.fallbacks.length; index++) {
    state.index = index;
    let fallback;
    try { fallback = await rule.fallbacks[index](signal); }
    catch (error) {
      signal?.throwIfAborted();
      preparationError = error;
      engine.ctx.logger?.warn(`compaction fallback preparation failed at ${index + 1} (${error.code ?? error.name}); trying the remaining configured route`);
      continue;
    }
    signal?.throwIfAborted();
    const key = JSON.stringify([fallback.provider, fallback.model]);
    if (state.attempted.has(key)) continue;
    state.attempted.add(key);
    Object.assign(state, fallback);
    engine.summaryFailures?.delete(agent);
    engine.ctx.logger?.warn(`compaction fallback: ${previous.provider}/${previous.model} -> ${fallback.provider}/${fallback.model} (${fallbackFailure(error).code})`);
    return fallback;
  }
  if (preparationError) {
    if (fallbackFailure(error, backoffCodes)) rememberSummaryFailure(engine, agent, error);
    throw preparationError;
  }
}

// Only follow the compacted surface span and the spans replaced by earlier
// checkpoints. A sibling turn, a failed call or arbitrary tool text is not a
// file receipt. Keep file content out of the checkpoint.
export function checkpointFileReferences(session, seqs) {
  const found = new Map();
  const seen = new Set();
  const spans = [seqs.values()];
  while (spans.length && seen.size < 8192) {
    const next = spans.at(-1).next();
    if (next.done) { spans.pop(); continue; }
    const seq = next.value;
    if (seen.has(seq)) continue;
    seen.add(seq);
    const event = session.eventAt(seq);
    if (event.type === 'user/message' && event.data.source?.kind === 'compact-checkpoint') {
      if (event.sourceEventSeqs) spans.push(event.sourceEventSeqs.values());
      continue;
    }
    if (event.type !== 'tool/result' || event.data.message.isError) continue;
    const { meta, message } = event.data;
    if (typeof meta?.path !== 'string' || !meta.path || meta.path.length > 512) continue;
    const call = event.sourceEventSeqs?.map(id => session.eventAt(id)).find(e =>
      e.type === 'tool/call' && e.data.callId === message.toolCallId);
    if (!call || !['read', 'write', 'edit'].includes(call.data.name)) continue;
    const ref = { path: meta.path };
    if (call.data.name === 'read') {
      const first = meta.lines?.[0]?.number, last = meta.lines?.at(-1)?.number;
      if (Number.isSafeInteger(first) && first > 0 && Number.isSafeInteger(last) && last >= first)
        ref.lines = [first, last];
    }
    const key = JSON.stringify(ref);
    if (found.keys().next().value === key) continue;
    found.delete(key);
    found.set(key, ref);
    // Preserve the earliest reference and the most recent working set.
    if (found.size > 8) found.delete([...found.keys()][1]);
  }
  return [...found.values()];
}

export function includeFileReferences(checkpoint, session, seqs, replacedTokens, meter) {
  const refs = checkpointFileReferences(session, seqs);
  if (!refs.length) return checkpoint;
  const maxTokens = Math.min(replacedTokens - 1, meter.estimateMessage(checkpoint) + 512);
  const selected = [];
  let result = checkpoint;
  for (const ref of [refs[0], ...refs.slice(1).reverse()]) {
    const text = 'For exact current values, read the listed path. For lines [first,last] use offset=first, limit=last-first+1.\n' +
      JSON.stringify([...selected, ref]);
    const candidate = createUserMessage({ content: [...checkpoint.content, { type: 'text', text }], source: checkpoint.source });
    if (meter.estimateMessage(candidate) > maxTokens) continue;
    selected.push(ref);
    result = candidate;
  }
  return result;
}

// 0.2.1-alpha.2 omits the routed reasoning control on auxiliary summary calls.
// Some chat templates put that control at the beginning of the system prompt,
// invalidating the entire warm prefix. Re-enter once with the explicit control,
// before observers and adapter validation; never mutate a frozen call envelope.
export function installCompactionRequestCompatibility(ctx, currentEffort = () => undefined) {
  return ctx.on('llm/stream', (options, next) => {
    if (options.purpose !== 'compaction' || options.reasoningEffort !== undefined) return next();
    const agent = ctx.agents.get(options.sessionId);
    const route = agent?.session.requestHeader()?.config;
    if (!route || route.reasoningEffort === undefined ||
        route.provider !== options.provider || route.model !== options.model) return next();
    // Session Controller owns live selection; AgentOptions are creation-time
    // defaults and need not match a routed request. Respect a pending switch.
    const pending = ctx.sessionProjections.stateOf(agent.session, 'modelSelection')?.pending;
    const effort = currentEffort(agent);
    if (pending && (pending.provider !== route.provider || pending.model !== route.model ||
        (effort ?? pending.reasoningEffort) !== route.reasoningEffort)) return next();
    if (effort !== undefined && effort !== route.reasoningEffort) return next();
    return ctx.llm.stream({ ...options, reasoningEffort: route.reasoningEffort });
  });
}

// Compatibility guard for 0.2.1-alpha.2. A large retained unit can leave only
// the prior checkpoint in the upstream-selected head. Re-summarizing that head
// before each tool step pays for no new facts and can progressively erode them.
// Keep selection, balancing, transaction, retry and overflow policy upstream.
export default class CompactionEngine extends BasicCompactionEngine {
  pressureAttempts = new WeakMap();
  manualSurfaces = new WeakMap();
  manualTargets = new WeakMap();
  summaryFailures = new WeakMap();
  summaryRetryCounts = new WeakMap();
  fallbackTargets = new WeakMap();
  get fallbackPolicies() { return this.ctx.get('codebuddyCompactionFallbacks') ?? []; }

  constructor(ctx, config) {
    super(ctx, config);
    // Automatic recovery needs both progress and backoff, with a per-turn cap.
    // Native idle and an explicit manual request reset that allowance.
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') {
        if (!fallbackFailure(this.summaryFailures.get(agent)?.error, connectionFailureCodes))
          this.summaryFailures.delete(agent);
        this.summaryRetryCounts.delete(agent);
        this.fallbackTargets.delete(agent);
      }
    });
  }

  async compactNow(agent, signal, sourceCommandId) {
    signal.throwIfAborted();
    const surface = () => JSON.stringify(agent.session.surface.nodes);
    // Repeating /compact without new conversation evidence needlessly summarizes
    // the same checkpoint again. Keep native admission and cancellation checks.
    if (this.manualSurfaces.get(agent) === surface()) {
      return agent.runMaintenance(async (agentSignal) => {
        AbortSignal.any([agentSignal, signal]).throwIfAborted();
        return null;
      });
    }
    const result = await super.compactNow(agent, signal, sourceCommandId);
    if (result) this.manualSurfaces.set(agent, surface());
    return result;
  }

  // The native hook keeps all rounds under one maintenance admission. Native
  // range selection, pairing, validation, durable commits and flushes stay intact.
  async finishManualCompaction(agent, compact, signal) {
    signal.throwIfAborted();
    // The native maintenance lock has admitted this explicit operation. A busy
    // or cancelled /compact must not clear a live turn's retry protection.
    this.summaryFailures.delete(agent);
    this.summaryRetryCounts.delete(agent);
    this.fallbackTargets.delete(agent);
    try {
      const target = idleTarget(this.ctx, agent);
      const rule = this.fallbackPolicies.find(rule => sameTarget(rule.source, target));
      const { provider, model } = target;
      const requestConfig = rule?.requestConfig ?? this.ctx.get('codebuddyCompactionRequestConfig') ?? target;
      const { reasoningEffort, temperature } = requestConfig;
      const maxTokens = agent.options.maxTokens ?? requestConfig.maxTokens;
      const call = await this.ctx.llm.prepareCall({ provider, model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        ...(temperature === undefined ? {} : { temperature }),
        ...(maxTokens === undefined ? {} : { maxTokens }) }, signal);
      if (!call.measure) throw new Error('The selected model adapter cannot verify post-compaction request fit');
      const measure = () => call.measure({ sessionId: agent.session.id, signal,
        messages: agent.session.deriveMessages(), tools: this.ctx.tools.schemas(agent), toolHistory: agent.session.toolHistory() });
      let before = await measure(), result;
      for (let round = 0; round < 8; round++) {
        signal.throwIfAborted();
        if (!sameTarget(idleTarget(this.ctx, agent), target)) throw new Error('Model selection changed during compaction; retry for the new selection');
        for (;;) {
          try { result = await compact(); break; }
          catch (error) {
            signal.throwIfAborted();
            if (!await activateFallback(this, agent, target, error, signal)) throw error;
          }
        }
        const after = await measure();
        signal.throwIfAborted();
        if (!sameTarget(idleTarget(this.ctx, agent), target)) throw new Error('Model selection changed during compaction; retry for the new selection');
        if (after.available >= after.minimumMaxTokens && after.effectiveMaxTokens >= after.minimumMaxTokens) {
          this.ctx.logger.info('manual compaction destination fit: ' + JSON.stringify({ provider, model,
            source: after.source, input: after.estimate.tokens, output: after.effectiveMaxTokens, window: after.contextWindow }));
          return result;
        }
        if (!result || !(after.estimate.tokens < before.estimate.tokens))
          throw Object.assign(new Error('Compaction cannot reduce the protected context enough for the selected model; completed checkpoints were preserved'), { code: 'COMPACTION_TARGET_WINDOW_EXCEEDED' });
        // A useful segment is not a model failure. Keep the successful route for
        // the next native range; only a real recoverable error advances fallback.
        before = after;
      }
      throw Object.assign(new Error('Compaction still exceeds the selected model window after 8 reductions; completed checkpoints were preserved'), { code: 'COMPACTION_TARGET_WINDOW_EXCEEDED' });
    } finally { this.fallbackTargets.delete(agent); }
  }

  regionDependencies() {
    return { ...super.regionDependencies(), includeFileReferences,
      onFailure: (error, session, compactionId) => {
        const { message: _message, ...diagnostic } = publicFailure(error,
          error instanceof LlmError ? { status: error.failure.status } : undefined);
        failureDiagnostics.set(session, { compactionId, diagnostic });
      },
    };
  }

  pressureTarget(agent) { return this.pressureAttempts.get(agent)?.target; }

  recordPressureSpec(agent, spec) { pressureSpecs.set(agent.session, spec); }

  async compactIfNeeded(agent, trigger, signal) {
    signal?.throwIfAborted();
    const target = trigger === 'pressure' ? idleTarget(this.ctx, agent) : agent.session.requestHeader()?.config;
    const route = summaryRoute(agent, this.config, target);
    const failed = this.summaryFailures.get(agent);
    if (failed) {
      const retries = this.summaryRetryCounts.get(agent) ?? 0;
      const changed = failed.route !== route;
      const grown = Number.isFinite(failed.tokens) &&
        (this.ctx.tokenMeter.measure(agent.session).totalTokens - failed.tokens >= SUMMARY_RETRY_POLICY.minGrowthTokens);
      if (retries >= SUMMARY_RETRY_POLICY.maxAutomaticRetries ||
          (!changed && !(performance.now() >= failed.retryAt && grown))) {
        if (trigger === 'pressure') return null;
        throw failed.error;
      }
      this.summaryRetryCounts.set(agent, retries + 1);
      this.summaryFailures.delete(agent);
      this.fallbackTargets.delete(agent);
      this.ctx.logger?.info('compaction summary recovery: ' + JSON.stringify({ attempt: retries + 1,
        maxAutomaticRetries: SUMMARY_RETRY_POLICY.maxAutomaticRetries, reason: changed ? 'configuration_changed' : 'history_growth_after_backoff' }));
    }
    const attempt = trigger === 'pressure' ? { result: null, target } : undefined;
    if (attempt) this.pressureAttempts.set(agent, attempt);
    try {
      for (;;) {
        try { return await super.compactIfNeeded(agent, trigger, signal); }
        catch (error) {
          if (error instanceof UnchangedCheckpoint) return attempt?.result ?? null;
          signal?.throwIfAborted();
          const target = attempt?.target ?? agent.session.requestHeader()?.config ?? agent.options;
          if (!await activateFallback(this, agent, target, error, signal)) throw error;
        }
      }
    } finally { if (attempt) this.pressureAttempts.delete(agent); }
  }

  async compactRegion(start, end, agent, signal) {
    signal?.throwIfAborted();
    const attempt = this.pressureAttempts.get(agent);
    if (attempt) {
      const nodes = agent.session.surface.nodes;
      const first = nodes.indexOf(start), last = nodes.indexOf(end);
      const messages = first < 0 || last < first ? [] : nodes.slice(first, last + 1)
        .map(seq => agent.session.deriveEventMessage(agent.session.eventAt(seq))).filter(message => message !== null);
      // Retained positional nodes may no longer produce messages. Test the
      // actual summary region before opening a transaction, or a no-op would
      // emit a failed compaction on every pressure step despite doing no work.
      if (messages.length === 1 && messages[0].role === 'user' && messages[0].source?.kind === 'compact-checkpoint')
        throw new UnchangedCheckpoint();
    }
    try {
      const result = await super.compactRegion(start, end, agent, signal);
      if (attempt) attempt.result = result;
      return result;
    } catch (error) {
      if (fallbackFailure(error, backoffCodes) && !signal?.aborted) rememberSummaryFailure(this, agent, error);
      throw error;
    }
  }

  async summarize(input, agent, signal) {
    signal?.throwIfAborted();
    const first = input.messages[0]?.role === 'system' ? 1 : 0;
    const message = input.messages[first];
    // Local fit preparation may shrink a larger region to its old checkpoint.
    // Guard the actual summary input as well as the original region entrance.
    if (this.pressureAttempts.has(agent) && input.messages.length === first + 1 &&
        message?.role === 'user' && message.source?.kind === 'compact-checkpoint')
      throw new UnchangedCheckpoint();
    const operation = agent.session.log.findLast(event => event.type === 'compaction/start' || event.type === 'compaction/end');
    let target = this.pressureAttempts?.get(agent)?.target ?? agent.session.requestHeader()?.config ?? agent.options;
    // Manual maintenance owns the null-turn marker. Pressure checks already
    // captured the next request route before starting their transaction.
    // Bind fit continuations to the same target even if the next selection changes.
    if (operation?.type === 'compaction/start' && operation.data.turn === null) {
      let selected = this.manualTargets.get(operation);
      if (!selected) {
        const pending = this.ctx.sessionProjections.stateOf(agent.session, 'modelSelection')?.pending;
        selected = { ...(pending ?? target) };
        this.manualTargets.set(operation, selected);
      }
      target = selected;
    }
    const policy = this.config.modelPolicies.find(p => p.provider === target.provider && p.model === target.model);
    // Match the native policy's nullish inheritance: an empty pair explicitly
    // clears an inherited dedicated summarizer and follows the conversation.
    const configuredProvider = policy?.summarizationProvider ?? this.config.summarizationProvider;
    const configuredModel = policy?.summarizationModel ?? this.config.summarizationModel;
    const summaryProvider = configuredProvider || target.provider;
    const summaryModel = configuredProvider ? configuredModel : target.model;
    const generate = async (summaryProvider, summaryModel, prepared) => {
      const info = await this.ctx.llm.resolveModelInfo?.(summaryProvider, summaryModel, signal);
      const window = info?.context?.contextWindow;
      const capacity = Number.isSafeInteger(window) && window > 0 ? window : Infinity;
      const initialBudget = Math.min(policy?.maxTokens ?? this.config.maxTokens, Math.max(1, Math.floor(capacity / 4)));
      const retryBudget = Math.min(initialBudget * 2, 32768, Math.max(1, Math.floor(capacity / 2)));
      // Summary generation has its own bounded reasoning allowance. It must not
      // inherit an xhigh task setting and consume the entire checkpoint budget.
      // Native request-fit still prices the whole envelope before sending it.
      const effort = info?.reasoning?.efforts?.some(e => e.id === 'low') ? 'low' : undefined;
      for (let attempt = 0; ; attempt++) {
        const maxTokens = attempt === 0 ? initialBudget : retryBudget;
        // A prepared fit continuation is single-use and bound to its exact cap.
        // A larger retry must pass through ordinary adapter preparation again.
        const stream = attempt === 0 && prepared && input.requestFitStream ? input.requestFitStream : options => this.ctx.llm.stream(options);
        const summaryStream = options => stream({ ...options, ...(effort ? { reasoningEffort: effort } : {}) });
        const owner = {
          ctx: { llm: { stream: summaryStream } },
          // The policy has already been resolved for this operation. Give the
          // native summarizer that exact target rather than selecting it again
          // from the historical request header. This is a call-local config.
          config: { ...this.config, maxTokens, summarizationProvider: summaryProvider,
            summarizationModel: summaryModel, modelPolicies: [] },
        };
        try {
          const result = await BasicCompactionEngine.prototype.summarize.call(owner,
            { ...input, requestFitStream: summaryStream }, agent, signal);
          this.summaryFailures?.delete(agent);
          return result;
        } catch (error) {
          signal?.throwIfAborted();
          if (attempt === 0 && error.code === 'MAX_TOKENS' && retryBudget > initialBudget) continue;
          throw error;
        }
      }
    };
    const active = this.fallbackTargets?.get(agent);
    let route = active?.provider && sameTarget(active.source, target) ? active : { provider: summaryProvider, model: summaryModel };
    let prepared = true;
    try {
      for (;;) {
        try { return await generate(route.provider, route.model, prepared); }
        catch (error) {
          signal?.throwIfAborted();
          const fallback = await activateFallback(this, agent, target, error, signal, route);
          if (!fallback) throw error;
          route = fallback;
          // Prepared continuations are pinned to one adapter, model and budget.
          prepared = false;
        }
      }
    } catch (error) {
      if (fallbackFailure(error, backoffCodes)) rememberSummaryFailure(this, agent, error);
      throw error;
    }
  }
}
