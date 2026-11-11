import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

class UnchangedCheckpoint extends Error {}
const summaryRoute = agent => {
  const route = agent.session.requestHeader()?.config ?? agent.options;
  return JSON.stringify([route.provider, route.model, route.reasoningEffort]);
};

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
  summaryFailures = new WeakMap();

  constructor(ctx, config) {
    super(ctx, config);
    // A failed summary must not become another paid request on every tool step.
    // The native turn boundary and an explicit manual request permit a fresh try.
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.summaryFailures.delete(agent);
    });
  }

  async compactNow(agent, signal, sourceCommandId) {
    signal.throwIfAborted();
    this.summaryFailures.delete(agent);
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

  regionDependencies() {
    return { ...super.regionDependencies(), includeFileReferences };
  }

  async compactIfNeeded(agent, trigger, signal) {
    signal?.throwIfAborted();
    const route = summaryRoute(agent);
    const failed = this.summaryFailures.get(agent);
    if (failed?.route === route) {
      if (trigger === 'pressure') return null;
      throw failed.error;
    }
    if (trigger !== 'pressure') return super.compactIfNeeded(agent, trigger, signal);
    const attempt = { result: null };
    this.pressureAttempts.set(agent, attempt);
    try { return await super.compactIfNeeded(agent, trigger, signal); }
    catch (error) {
      if (error instanceof UnchangedCheckpoint) return attempt.result;
      throw error;
    } finally { this.pressureAttempts.delete(agent); }
  }

  async compactRegion(start, end, agent, signal) {
    signal?.throwIfAborted();
    const attempt = this.pressureAttempts.get(agent);
    const event = start === end ? agent.session.eventAt(start) : undefined;
    if (attempt && event?.type === 'user/message' && event.data.source?.kind === 'compact-checkpoint')
      throw new UnchangedCheckpoint();
    const result = await super.compactRegion(start, end, agent, signal);
    if (attempt) attempt.result = result;
    return result;
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
    const target = agent.session.requestHeader()?.config ?? agent.options;
    const policy = this.config.modelPolicies.find(p => p.provider === target.provider && p.model === target.model);
    const summaryProvider = policy?.summarizationProvider || this.config.summarizationProvider || target.provider;
    const summaryModel = policy?.summarizationModel || this.config.summarizationModel || target.model;
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
      const stream = attempt === 0 && input.requestFitStream ? input.requestFitStream : options => this.ctx.llm.stream(options);
      const summaryStream = options => stream({ ...options, ...(effort ? { reasoningEffort: effort } : {}) });
      const owner = {
        ctx: { llm: { stream: summaryStream } },
        config: { ...this.config, maxTokens,
          modelPolicies: this.config.modelPolicies.map(p => ({ ...p, maxTokens })) },
      };
      try {
        const result = await BasicCompactionEngine.prototype.summarize.call(owner,
          { ...input, requestFitStream: summaryStream }, agent, signal);
        this.summaryFailures?.delete(agent);
        return result;
      } catch (error) {
        signal?.throwIfAborted();
        if (attempt === 0 && error.code === 'MAX_TOKENS' && retryBudget > initialBudget) continue;
        if (['MAX_TOKENS', 'OUTPUT_TRUNCATED', 'EMPTY_RESPONSE', 'COMPACTION_EMPTY_SUMMARY'].includes(error.code)) {
          this.summaryFailures?.set(agent, {
            route: summaryRoute(agent), error,
          });
        }
        throw error;
      }
    }
  }
}
