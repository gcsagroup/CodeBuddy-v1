import { isOutputLimitFailure } from './output-recovery.mjs';

// Readonly display projection. Native turn/end remains the termination authority.
export function userTurnTerminals(events) {
  const terminals = [], queued = new Map();
  let turn, sourceIds = [], previous = [], continuation = false, independentInput = false, steersOnly = true;
  for (const event of events) {
    if (event.type === 'agent/inbox/spliced') {
      for (const message of event.data.inserted) queued.set(message.id, event.data.target);
    } else if (event.type === 'turn/start') {
      turn = event.data.turn; sourceIds = []; continuation = false; independentInput = false; steersOnly = true;
    } else if (event.type === 'user/message' && turn !== undefined) {
      const message = event.data, target = queued.get(message.id);
      queued.delete(message.id);
      if (message.source?.kind === 'user') {
        // A steer can start another native turn while the initiating ACP prompt
        // is still waiting for children. A new queued prompt owns a new group.
        if (message.source.rpcId) {
          steersOnly &&= target === 'next-step';
          sourceIds.push(message.source.rpcId);
        } else independentInput = true;
      } else if (message.source?.kind === 'subagent-settled' || target === 'next-step') continuation = true;
      // next-step relays and tool contexts enrich the current request; only a
      // separate queued turn (or an unaddressable human input) breaks its owner.
      else if (target === 'next-turn') independentInput = true;
    } else if (event.type === 'turn/end' && event.data.turn === turn) {
      const reason = event.data.reason;
      // Only native inbox continuations inherit the completed turn's
      // owner. Scheduled/other inbox input, cancellation and failure break it.
      let owners = sourceIds;
      if (!independentInput) {
        if (sourceIds.length && steersOnly) owners = [...previous, ...sourceIds];
        else if (!sourceIds.length && continuation) owners = previous;
      }
      if (owners.length && (reason.kind === 'error' && !isOutputLimitFailure(reason.error.code) ||
          reason.kind === 'aborted' && reason.reason?.kind === 'user'))
        terminals.push({ sourceId: owners[0], sourceIds: [...owners], time: event.time, reason: structuredClone(reason) });
      previous = reason.kind === 'completed' ? owners : [];
      turn = undefined;
    }
  }
  return terminals;
}
