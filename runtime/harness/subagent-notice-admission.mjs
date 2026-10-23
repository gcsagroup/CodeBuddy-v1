import { isDeepStrictEqual } from 'node:util';

const isNotice = message => message.source?.kind === 'subagent-settled';

/** Keep original native notices pending until their native admission is logged. */
export function installSubagentNoticeAdmission(ctx, currentRun) {
  async function reconcile(agent, signal) {
    const pending = new Map(agent.inbox.nextTurn.filter(isNotice).map(message => [message.id, message]));
    if (!pending.size) return;
    const observation = await ctx.sessionQuery.observeSession(agent.id, { signal, projectionMode: 'none' });
    try {
      signal?.throwIfAborted();
      if (ctx.agents.get(agent.id) !== agent) return;
      // A crash can leave an already admitted original in the pending queue.
      // The native user/message record is its receipt; never keep a second ledger.
      const events = observation.events;
      for (let index = events.length - 1; index >= observation.inheritedEventCount && pending.size; index--) {
        const event = events[index];
        if (event.type !== 'user/message' || !isNotice(event.data)) continue;
        const message = pending.get(event.data.id);
        if (!message || !isDeepStrictEqual(event.data, message)) continue;
        // Recheck the current occurrence after the asynchronous observation.
        if (agent.inbox.nextTurn.some(item => isDeepStrictEqual(item, message))) agent.inbox.remove(message.id);
        pending.delete(message.id);
      }
    } finally {
      observation[Symbol.dispose]();
    }
  }

  const releaseStep = ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next();
    const run = currentRun(agent);
    if (!run || run.cancelRequested || signal.aborted || decision.kind !== 'enter') return decision;
    const human = message => message.source?.kind === 'user';
    if (!decision.messages.some(message => human(message) && message.source.rpcId === run.requestId) ||
        decision.messages.some(message => human(message) && message.source.rpcId !== run.requestId)) return decision;
    const parked = [...agent.inbox.nextTurn];
    if (!parked.length || !parked.every(isNotice)) return decision;
    // pre-step is the public native batch-admission extension point. Keep each
    // original id, source and content, and do not remove it before admission.
    return { ...decision, messages: [...decision.messages, ...parked] };
  });
  const releaseStream = ctx.on('llm/stream', (options, next) => (async function* () {
    const agent = ctx.agents.get(options.sessionId);
    if (agent && currentRun(agent)) await reconcile(agent, options.signal);
    yield* next();
  })());

  return {
    reconcile,
    dispose() { releaseStep(); releaseStream(); },
  };
}
