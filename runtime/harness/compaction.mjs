import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';

class UnchangedCheckpoint extends Error {}

// 0.2.1-alpha.2 omits the routed reasoning control on auxiliary summary calls.
// Some chat templates put that control at the beginning of the system prompt,
// invalidating the entire warm prefix. Re-enter once with the explicit control,
// before observers and adapter validation; never mutate a frozen call envelope.
export function installCompactionRequestCompatibility(ctx, currentEffort = () => undefined) {
  return ctx.on('llm/stream', (options, next) => {
    if (options.purpose !== 'compaction' || options.reasoningEffort !== undefined) return next();
    const agent = ctx.agents.get(options.sessionId);
    if (!agent) return next();
    const pending = ctx.sessionProjections.stateOf(agent.session, 'modelSelection')?.pending;
    const effort = currentEffort(agent);
    if (pending) {
      if (pending.provider !== options.provider || pending.model !== options.model) return next();
      const selectedEffort = effort ?? pending.reasoningEffort;
      return selectedEffort === undefined ? next() : ctx.llm.stream({ ...options, reasoningEffort: selectedEffort });
    }
    const route = agent?.session.requestHeader()?.config;
    if (!route || route.reasoningEffort === undefined ||
        route.provider !== options.provider || route.model !== options.model) return next();
    // Session Controller owns live selection; AgentOptions are creation-time
    // defaults and need not match a routed request. Respect a pending switch.
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
    if (this.modelError) throw new Error(this.modelError);
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
