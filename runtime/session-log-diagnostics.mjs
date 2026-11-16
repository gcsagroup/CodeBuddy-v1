import { publicFailure } from './error-presentation.mjs';
import { diagnosticRedaction } from './session-log-redaction.mjs';

const reasons = new Set(['completed', 'error', 'aborted', 'interrupted', 'forked', 'blocked', 'max-tokens']);
const numbers = ['turn', 'step', 'attempt', 'retry', 'maxRetries', 'delayMs', 'retryAfterMs', 'inputTokens',
  'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens',
  'contextWindow', 'maxTokens', 'shadowedTokenCount', 'durationMs', 'exitCode',
  'desiredMaxTokens', 'effectiveMaxTokens', 'minimumMaxTokens', 'safetyTokens', 'available'];
const numeric = source => Object.fromEntries(numbers.filter(key => Number.isSafeInteger(source?.[key]) && (key === 'exitCode' || source[key] >= 0))
  .map(key => [key, source[key]]));
const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const finishKinds = new Set(['stop', 'tool-calls', 'max-tokens', 'error', 'aborted']);

// This is a shareable observation, never a session archive or a replay input.
// Allowlist fields instead of trying to recognise secrets inside arbitrary prose.
export function sessionLogDiagnostics(text, { detail = 'standard', observations = [] } = {}) {
  if (!['standard', 'detailed'].includes(detail)) throw new TypeError('Unsupported diagnostic detail');
  let rows;
  try { rows = text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
  catch { throw new Error('无法读取会话日志；本机原始历史未修改。'); }
  if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row)))
    throw new Error('无法读取会话日志；本机原始历史未修改。');
  const firstTime = rows.find(row => Number.isFinite(row.time))?.time;
  const { technical, tool, argumentsShape, schema, excerpt, headers } = diagnosticRedaction(rows);
  const route = source => ({ ...(typeof source?.provider === 'string' ? { provider: technical(source.provider) } : {}),
    ...(typeof source?.model === 'string' ? { model: technical(source.model) } : {}) });
  const usage = (value, source) => ({ source, ...numeric(value) });
  const diagnostic = error => error?.code === 'TOOL_OUTCOME_UNKNOWN'
    ? { code: 'TOOL_OUTCOME_UNKNOWN', message: '工具执行中断，结果未知；请先核对外部状态，不要盲目重试。' }
    : publicFailure(typeof error === 'object' ? error : {});
  const details = entries => {
    const result = {};
    for (const [key, value] of Object.entries(entries)) {
      const redacted = excerpt(value, key === 'output' ? 'output' : 'error');
      if (redacted) { result[key] = redacted.text; result[key + 'Characters'] = value.length; if (redacted.truncated) result.truncated = true; }
    }
    return Object.keys(result).length ? result : undefined;
  };
  // Preserve original evidence separately from public classifications. This is
  // an export projection; provider prose never decides retries or recovery.
  const errorRecord = (value, depth = 0) => {
    if (typeof value === 'string') return details({ message: value });
    if (!value || typeof value !== 'object') return undefined;
    if (depth >= 5) return { omitted: 'exception depth limit' };
    const result = {};
    for (const key of ['code', 'name', 'type', 'param', 'requestId', 'request_id', 'traceId', 'trace_id', 'finish_reason']) {
      if (typeof value[key] === 'string') result[key] = technical(value[key]);
      else if (key === 'code' && Number.isSafeInteger(value[key])) result[key] = value[key];
    }
    for (const key of ['status', 'httpStatus', 'statusCode', 'retryAfterMs']) if (Number.isSafeInteger(value[key])) result[key] = value[key];
    for (const key of ['headers', 'responseHeaders']) {
      const metadata = headers(value[key]);
      if (metadata && Object.keys(metadata).length) result[key] = metadata;
    }
    Object.assign(result, details({ message: value.message, stack: value.stack }));
    for (const key of ['cause', 'failure', 'error', 'data']) {
      const nested = errorRecord(value[key], depth + 1);
      if (nested && Object.keys(nested).length) result[key] = nested;
    }
    if (Array.isArray(value.errors)) result.errors = value.errors.slice(0, 8).map(item => errorRecord(item, depth + 1));
    if (value.errors?.length > 8) result.omittedErrors = value.errors.length - 8;
    return result;
  };
  const textOf = content => Array.isArray(content) ? content.filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n') : undefined;
  const config = value => ({ ...route(value), ...numeric(value),
    ...(efforts.has(value?.reasoningEffort) ? { reasoningEffort: value.reasoningEffort } : {}),
    ...(Number.isFinite(value?.temperature) ? { temperature: value.temperature } : {}),
    ...Object.fromEntries(['engine', 'api', 'apiUrl', 'baseUrl'].filter(key => typeof value?.[key] === 'string').map(key => [key, technical(value[key])])) });
  const output = [{ type: 'log-export', revision: 'codebuddy-log-v3', detail,
    containsTextExcerpts: true, includesToolOutput: detail === 'detailed', restorable: false, eventCount: Math.max(0, rows.length - 1),
    exportEnvironment: { platform: process.platform, arch: process.arch, node: process.versions.node },
    omissions: ['credentials', 'conversation', 'reasoning', 'attachments', 'recovery_payloads', 'unrecognised_fields'],
    historicalFacts: 'recorded_events_only', wirePayload: 'not_recorded',
    session: { id: technical(rows[0]?.id), parentSession: technical(rows[0]?.parentSession),
      ...(Number.isSafeInteger(rows[0]?.version) ? { journalVersion: rows[0].version } : {}),
      ...(typeof rows[0]?.isSeeded === 'boolean' ? { isSeeded: rows[0].isSeeded } : {}) } }];
  // Saved product observations can retain an HTTP status absent from the native
  // failure. Keep them separate; never infer a match from error prose or time.
  output[0].observations = observations.flatMap(update => {
    const value = update.status?.data;
    if (!value?.diagnostic) return [];
    return [{ source: 'saved_product_diagnostic', runId: technical(value.run_id),
      sourceUserMessageId: technical(value.source_user_message_id), operationId: technical(value.operation_id),
      diagnostic: diagnostic(value.diagnostic) }];
  });
  // Give recent failure evidence priority within separate error/output budgets.
  // The returned event order and every event's sequence number stay unchanged.
  for (const row of rows.slice(1).reverse()) {
    const source = row.data ?? {}, data = numeric(source);
    if (source.turn === null) data.turn = null;
    for (const key of ['callId', 'attemptId', 'id', 'messageId', 'compactionId', 'sourceCommandId', 'requestId', 'childId']) {
      const value = technical(source[key]);
      if (value !== undefined) data[key] = value;
    }
    const resultCall = technical(source.message?.toolCallId);
    if (typeof source.message?.id === 'string') data.messageId ??= technical(source.message.id);
    if (resultCall !== undefined) data.callId = resultCall;
    if (typeof source.message?.isError === 'boolean') data.isError = source.message.isError;
    if (Array.isArray(source.message?.content)) data.contentBlocks = source.message.content.length;
    if (reasons.has(source.reason?.kind)) data.reason = source.reason.kind;
    const error = source.reason?.kind === 'error' ? source.reason.error : source.error ?? source.failure;
    if (error !== undefined) {
      // Native compaction errors can be strings. Do not infer their meaning or
      // copy the provider's payload when no structured classification survived.
      data.diagnostic = diagnostic(error);
      data.error = errorRecord(error);
    }
    if (['request/context', 'model/selection', 'compaction/summary'].includes(row.type)) data.route = route(source);
    if (row.type === 'request/header') {
      const header = source.header ?? {};
      data.request = { source: 'native_header', wirePayload: 'not_recorded', config: config(header.config),
        adapterDefaults: Object.fromEntries(['maxTokens', 'reasoningEffort'].filter(key => header.adapterDefaults?.[key] === true).map(key => [key, true])),
        tools: { present: Array.isArray(header.tools), count: Array.isArray(header.tools) ? header.tools.length : 0,
          state: !Object.hasOwn(header, 'tools') ? 'absent' : header.tools === null ? 'null' : Array.isArray(header.tools) ? (header.tools.length ? 'nonempty' : 'empty') : 'invalid',
          declarations: Array.isArray(header.tools) ? header.tools.map(item => ({ name: tool(item.name),
            ...(item.parameters ? { parameters: schema(item.parameters) } : {}) })) : [] } };
      if (typeof source.startsSeries === 'boolean') data.request.startsSeries = source.startsSeries;
      if (['initial', 'resume', 'change', 'series'].includes(source.reason)) data.request.reason = source.reason;
    }
    if (row.type === 'user/message' && source.source && typeof source.source === 'object') data.source = {
      senderSessionId: technical(source.source.senderSessionId), rpcId: technical(source.source.rpcId),
      kind: ['user', 'subagent-settled', 'agent-message', 'schedule', 'goal'].includes(source.source.kind) ? source.source.kind : 'other',
    };
    if (row.type === 'agent/inbox/spliced') {
      if (['next-step', 'next-turn'].includes(source.target)) data.target = source.target;
      if (Array.isArray(source.inserted)) data.inserted = source.inserted.map(item => ({ id: technical(item?.id) }));
    }
    if (row.type === 'compaction/summary') {
      if (source.shadowedRange && Number.isInteger(source.shadowedRange.start) && Number.isInteger(source.shadowedRange.end))
        data.shadowedRange = { start: source.shadowedRange.start, end: source.shadowedRange.end };
      if (Array.isArray(source.shadowedSeqs)) data.shadowedSeqs = source.shadowedSeqs.filter(Number.isSafeInteger);
      if (Array.isArray(source.summary)) data.summaryBlocks = source.summary.length;
    }
    if (source.usage && typeof source.usage === 'object') data.usage = usage(source.usage, row.type);
    if (source.message?.usage) data.usage = usage(source.message.usage, row.type);
    if (row.type === 'tool/call') {
      data.name = tool(source.name);
      if (source.arguments !== undefined) data.arguments = argumentsShape(source.arguments);
    }
    if (row.type === 'tool/result') {
      if (Array.isArray(source.message?.content)) data.blockTypes = source.message.content.map(block =>
        ['text', 'image', 'resource', 'resource_link', 'audio'].includes(block?.type) ? block.type : 'other');
      const text = textOf(source.message?.content);
      if (source.message?.isError && error === undefined) data.error = errorRecord({ message: text });
      const output = detail === 'detailed' ? details({ output: text }) : undefined;
      if (output) data.details = { ...data.details, ...output };
    }
    if (row.type === 'assistant/attempt' && Array.isArray(source.stream)) {
      const summary = { records: source.stream.length, textCharacters: 0, reasoningCharacters: 0, argumentCharacters: 0, usage: [], finishes: [] };
      for (const record of source.stream) {
        if (['text-chunks', 'reasoning-chunks', 'tool-call-chunks'].includes(record?.type)) {
          const size = (record.texts ?? record.args ?? []).reduce((sum, value) => sum + (typeof value === 'string' ? value.length : 0), 0);
          summary[record.type === 'text-chunks' ? 'textCharacters' : record.type === 'reasoning-chunks' ? 'reasoningCharacters' : 'argumentCharacters'] += size;
        }
        if (record?.type !== 'chunk') continue;
        const chunk = record.chunk;
        if (chunk?.type === 'usage') summary.usage.push(usage(chunk.usage, 'stream'));
        if (chunk?.type === 'finish') {
          const finish = { kind: finishKinds.has(chunk.reason?.kind) ? chunk.reason.kind : 'unknown' };
          if (chunk.reason?.failure) {
            finish.diagnostic = diagnostic(chunk.reason.failure);
            finish.error = errorRecord(chunk.reason.failure);
          }
          summary.finishes.push(finish);
        }
      }
      data.stream = summary;
    }
    output.push({ type: technical(row.type) ?? 'other',
      ...(Number.isSafeInteger(row.seq) && row.seq >= 0 ? { seq: row.seq } : {}),
      ...(Number.isFinite(row.time) ? { time: row.time } : {}),
      ...(Number.isFinite(firstTime) && Number.isFinite(row.time) ? { elapsedMs: row.time - firstTime } : {}), data });
  }
  return [output[0], ...output.slice(1).reverse()].map(row => JSON.stringify(row)).join('\n') + '\n';
}
