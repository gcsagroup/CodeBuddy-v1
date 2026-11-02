// Injected into the hash-locked native Schedule module. Its helpers and queue
// are the native module's own bindings, not a second scheduler or task store.
export async function setPaused(request, signal) {
  const started = performance.now();
  const operationId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  // Diagnostics must not affect a committed operation or expose task contents.
  const trace = (stage, details = {}) => {
    try {
      console.info('[schedule-control-timing]', JSON.stringify({
        source: 'native', operationId, taskId: request.id, sessionId: request.sessionId,
        action: request.paused ? 'pause' : 'resume', stage, at: new Date().toISOString(),
        elapsedMs: Math.round(performance.now() - started), ...details,
      }));
    } catch { /* Logging is best effort. */ }
  };
  trace('queued');
  try {
    const result = await this.serialize(async () => {
      trace('queue_entered');
      const tasks = (await this.getDomain()).table('tasks');
      signal?.throwIfAborted();
      const current = tasks.get(request.id);
      const miss = code => ({ id: request.id, changed: false, code });
      if (!current || current.sessionId !== request.sessionId) return miss('schedule_not_found');
      if (current.status !== request.expectedStatus || !isDeepStrictEqual(current.record, request.expected))
        return miss('schedule_conflict');
      if (current.status === 'inactive') return miss('schedule_ended');
      const target = request.paused ? 'paused' : 'active';
      if (current.status === target) return { id: request.id, changed: false, status: target };
      if (!request.paused) {
        const refusal = this.reminderTargetRefusal(request.sessionId);
        if (refusal) return refusal;
      }
      let record = current.record;
      let status = target;
      const now = Date.now();
      if (!request.paused && Date.parse(record.scheduledAt) <= now) {
        // Keep the native cadence/zone and skip missed occurrences. An expired
        // one-shot ends without delivery; a future one-shot keeps its target.
        const next = isRecurringScheduleRecord(record)
          ? resolveRecurringOccurrence(record, now).nextScheduledAt : undefined;
        if (next === undefined) status = 'inactive';
        else record = { ...record, scheduledAt: next };
      }
      trace('persist_started');
      await tasks.put(request.id, { ...current, record, status });
      trace('persist_finished', { status });
      this.emitChanged();
      this.runtime?.requestDrive();
      return { id: request.id, changed: true, status };
    });
    trace('finished', { changed: result.changed === true, status: result.status,
      refused: result.code !== undefined });
    return result;
  } catch (error) {
    trace('failed');
    throw error;
  }
}
