import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

class UnchangedCheckpoint extends Error {}

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

  regionDependencies() {
    return { ...super.regionDependencies(), includeFileReferences };
  }

  async compactIfNeeded(agent, trigger, signal) {
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
    return super.summarize(input, agent, signal);
  }
}
