// Live presentation only. Native events remain the execution/terminal authority.
export function workStatusUpdates({ sessionId, sourceMessageId, runId, signal }) {
  const children = new Set();
  let previous;
  return event => {
    if (signal?.aborted) return [];
    let phase;
    if (event.type === 'subagent_start' && event.sessionId === sessionId) {
      children.add(event.childSessionId);
      phase = 'children';
    } else if (event.type === 'subagent_end' && children.delete(event.childSessionId)) {
      phase = children.size ? 'children' : 'child_result';
    } else if (event.type === 'harness_event' && event.sessionId && event.sessionId !== sessionId) {
      // Native turns cover resumed children too; spawning is not the only way to work.
      if (event.event.type === 'turn/start') {
        children.add(event.sessionId);
        phase = 'children';
      } else if (event.event.type === 'turn/end' && children.delete(event.sessionId)) {
        phase = children.size ? 'children' : 'child_result';
      }
    } else if (event.sessionId === sessionId) {
      if (event.type === 'assistant_start' || event.type === 'assistant_committed')
        phase = children.size ? 'children' : 'model';
      else if (event.type === 'tool_result' && !event.internalControl)
        phase = children.size ? 'children' : 'tool_result';
    }
    if (!phase) return [];
    const key = `${phase}:${children.size}`;
    if (key === previous) return [];
    previous = key;
    return [{ sessionUpdate: 'status_message', status: { type: 'progress', message: '', data: {
      schema_version: 1, event: 'execution_activity', source_user_message_id: sourceMessageId,
      run_id: runId, phase, child_count: children.size,
    } } }];
  };
}
