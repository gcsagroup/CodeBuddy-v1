import { publicFailure } from './error-presentation.mjs';

// Translate official Harness facts into the existing desktop notification
// contract. This adapter never selects a range or decides whether to compact.
export function unfinishedCompactions(updates) {
  const open = new Map();
  for (const update of updates) {
    const data = update.status?.data;
    if (data?.event !== 'compaction_lifecycle') continue;
    if (data.status === 'started') open.set(data.operation_id, update);
    else open.delete(data.operation_id);
  }
  return [...open.values()];
}

// Called only when no live product operation owns this session. Preserve the
// journal, reconcile lost notifications from native durable facts, and stop a
// dead UI spinner without inventing a successful summary or changing execution.
export function recoveredCompactionUpdates(open, events) {
  const ends = new Map(events.filter(event => event.type === 'compaction/end').map(event => [event.data.compactionId, event.data]));
  return open.map(update => {
    const end = ends.get(update.status.data.operation_id);
    const failure = end?.error ? publicFailure(typeof end.error === 'object' ? end.error : undefined) : null;
    const { message, ...diagnostic } = failure ?? {};
    const error = end ? message : '进程已退出，未收到运行时压缩结束确认；原始记录保留。';
    return { ...update, status: { ...update.status,
      message: end ? error ? '上下文压缩失败' : '上下文压缩完成' : '上下文压缩已中断，结果未确认',
      data: { ...update.status.data, status: error ? 'failed' : 'completed', ...(error ? { error } : {}), ...(failure ? { diagnostic } : {}) },
    } };
  });
}

// Read old error projections safely without rewriting the private transcript.
export function publicErrorUpdate(update) {
  const data = update.status?.data;
  if (update.sessionUpdate !== 'status_message' || !data) return update;
  if (data.event === 'compaction_lifecycle' && data.error) {
    const { message: error, ...diagnostic } = publicFailure(data.diagnostic ?? (typeof data.error === 'object' ? data.error : undefined));
    return { ...update, status: { ...update.status, message: data.status === 'cancelled' ? '上下文压缩已取消' : '上下文压缩失败', data: { ...data, error, diagnostic } } };
  }
  if (data.event_type === 'run_failed') {
    const { message, ...diagnostic } = publicFailure(data.diagnostic);
    return { ...update, status: { ...update.status, message, data: { ...data, title: message, diagnostic } } };
  }
  if (data.terminal_message_id && data.status === 'failed') {
    const { message, ...diagnostic } = publicFailure(data.diagnostic);
    return { ...update, status: { ...update.status, message, data: { ...data, diagnostic,
      ...(data.report ? { report: { ...data.report, limitations: [message, ...(Array.isArray(data.report.limitations) ? data.report.limitations : []).filter(value => [
        'Turn completion does not assert independent acceptance; inspect the recorded tool results.',
        'Some tool effects still require inspection before retrying them.',
      ].includes(value))] } } : {}),
    } } };
  }
  return update;
}

export function contextUpdates({ sessionId, runId, signal } = {}) {
  const starts = new Map();
  return event => {
    if (event.sessionId && event.sessionId !== sessionId) return [];
    if (event.type === 'assistant_start' || event.type === 'assistant_end')
      return [{ sessionUpdate: 'status_message', status: { type: 'progress', message: '', data: {
        schema_version: 1, event: 'live_decode_speed', liveSpeed: event.type === 'assistant_start' ? { rate: null, estimated: false } : null,
      } } }];
    if (event.type === 'model_diagnostic' && event.phase === 'request_budget' && !event.purpose)
      return [{ sessionUpdate: 'status_message', status: { type: 'progress', message: '', data: {
        schema_version: 1, event: 'request_budget', model: event.model, source: event.source,
        input: event.input, output: event.output, window: event.window,
      } } }];
    if (event.type === 'context_usage') {
      if (!Number.isFinite(event.used) || !Number.isFinite(event.contextLimit)) return [];
      return [{
        sessionUpdate: 'usage_update', used: event.used, contextLimit: event.contextLimit,
        accumulatedInputTokens: event.accumulatedInputTokens,
        accumulatedOutputTokens: event.accumulatedOutputTokens,
        _meta: { harness: { revision: event.revision, source: event.source, contextSource: event.contextSource } },
      }, { sessionUpdate: 'status_message', status: { type: 'progress', message: '', data: {
        schema_version: 1, event: 'context_meter', used: event.used, contextLimit: event.contextLimit,
        source: event.source, contextSource: event.contextSource,
        ...(event.sessionStats ? { sessionStats: event.sessionStats } : {}),
        ...(event.liveSpeed ? { liveSpeed: event.liveSpeed } : {}),
      } } }];
    }
    if (event.type !== 'harness_event') return [];
    const native = event.event, data = native.data;
    if (!['compaction/start', 'compaction/end'].includes(native.type)) return [];
    if (native.type === 'compaction/start') starts.set(data.compactionId, new Date(native.time).toISOString());
    const started = starts.get(data.compactionId);
    if (!started) return [];
    const status = native.type === 'compaction/start' ? 'started'
      : data.error ? signal?.aborted ? 'cancelled' : 'failed' : 'completed';
    const failure = data.error ? publicFailure(event.diagnostic ?? (typeof data.error === 'object' ? data.error : undefined)) : null;
    const { message: error, ...diagnostic } = failure ?? {};
    if (native.type === 'compaction/end') starts.delete(data.compactionId);
    return [{ sessionUpdate: 'status_message', status: {
      type: 'progress',
      message: { started: '正在压缩上下文…', completed: '上下文压缩完成', failed: '上下文压缩失败', cancelled: '上下文压缩已取消' }[status],
      data: {
        schema_version: 1, event: 'compaction_lifecycle', operation_id: data.compactionId,
        status, trigger: data.turn === null ? 'manual' : 'auto', started_at: started,
        ...(runId ? { origin: { run_id: runId } } : {}),
        ...(failure ? { error, diagnostic } : {}),
      },
    } }];
  };
}
