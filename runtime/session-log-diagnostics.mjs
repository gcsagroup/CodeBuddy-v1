import { publicFailure } from './error-presentation.mjs';
import { diagnosticRedaction } from './session-log-redaction.mjs';

const types = new Set([
  'turn/start', 'turn/end', 'step/start', 'step/end', 'user/message', 'assistant/message',
  'assistant/attempt', 'tool/call', 'tool/result', 'llm/retry', 'llm/retry-started',
  'compaction/start', 'compaction/end', 'compaction/summary', 'request/header', 'request/context',
  'system/message', 'session/title', 'session/title-llm-request', 'model/selection',
  'permission/preset', 'sandbox/mode', 'approval/policy', 'agent/inbox/spliced',
  'subagent/catalog',
]);
const reasons = new Set(['completed', 'error', 'aborted', 'interrupted', 'forked', 'blocked', 'max-tokens']);
const numbers = ['turn', 'step', 'attempt', 'retry', 'maxRetries', 'delayMs', 'inputTokens',
  'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens',
  'contextWindow', 'maxTokens', 'shadowedTokenCount', 'durationMs', 'exitCode'];
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
  catch { throw new Error('无法读取会话诊断；本机原始历史未修改。'); }
  if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row)))
    throw new Error('无法读取会话诊断；本机原始历史未修改。');
  const firstTime = rows.find(row => Number.isFinite(row.time))?.time;
  const { alias, tool, argumentsShape, schema, excerpt } = diagnosticRedaction(rows);
  const route = source => ({ ...(typeof source?.provider === 'string' ? { provider: alias(source.provider, 'provider') } : {}),
    ...(typeof source?.model === 'string' ? { model: alias(source.model, 'model') } : {}) });
  const usage = (value, source) => ({ source, ...numeric(value) });
  const diagnostic = error => error?.code === 'TOOL_OUTCOME_UNKNOWN'
    ? { code: 'TOOL_OUTCOME_UNKNOWN', message: '工具执行中断，结果未知；请先核对外部状态，不要盲目重试。' }
    : publicFailure(typeof error === 'object' ? error : {});
  const details = entries => {
    if (detail !== 'detailed') return undefined;
    const result = {};
    for (const [key, value] of Object.entries(entries)) {
      const redacted = excerpt(value, key === 'output' ? 'output' : 'error');
      if (redacted) { result[key] = redacted.text; result[key + 'Characters'] = value.length; if (redacted.truncated) result.truncated = true; }
    }
    return Object.keys(result).length ? result : undefined;
  };
  const textOf = content => Array.isArray(content) ? content.filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n') : undefined;
  const config = value => ({ ...route(value), ...numeric(value),
    ...(efforts.has(value?.reasoningEffort) ? { reasoningEffort: value.reasoningEffort } : {}),
    ...(Number.isFinite(value?.temperature) ? { temperature: value.temperature } : {}) });
  const output = [{ type: 'log-export', revision: 'codebuddy-log-v2', detail,
    containsTextExcerpts: detail === 'detailed', restorable: false, eventCount: Math.max(0, rows.length - 1),
    exportEnvironment: { platform: process.platform, arch: process.arch, node: process.versions.node },
    omissions: ['credentials', 'conversation', 'reasoning', 'attachments', 'recovery_payloads', 'unrecognised_fields'],
    historicalFacts: 'recorded_events_only', wirePayload: 'not_recorded',
    session: { id: alias(rows[0]?.id), parentSession: alias(rows[0]?.parentSession),
      ...(Number.isSafeInteger(rows[0]?.version) ? { journalVersion: rows[0].version } : {}),
      ...(typeof rows[0]?.isSeeded === 'boolean' ? { isSeeded: rows[0].isSeeded } : {}) } }];
  // Saved product observations can retain an HTTP status absent from the native
  // failure. Keep them separate; never infer a match from error prose or time.
  output[0].observations = observations.flatMap(update => {
    const value = update.status?.data;
    if (!value?.diagnostic) return [];
    return [{ source: 'saved_product_diagnostic', runId: alias(value.run_id),
      sourceUserMessageId: alias(value.source_user_message_id), operationId: alias(value.operation_id),
      diagnostic: diagnostic(value.diagnostic) }];
  });
  // Give recent failure evidence priority within separate error/output budgets.
  // The returned event order and every event's sequence number stay unchanged.
  for (const row of rows.slice(1).reverse()) {
    const source = row.data ?? {}, data = numeric(source);
    if (source.turn === null) data.turn = null;
    for (const key of ['callId', 'attemptId', 'id', 'messageId', 'compactionId', 'sourceCommandId', 'requestId', 'childId']) {
      const value = alias(source[key]);
      if (value !== undefined) data[key] = value;
    }
    const resultCall = alias(source.message?.toolCallId);
    if (resultCall !== undefined) data.callId = resultCall;
    if (typeof source.message?.isError === 'boolean') data.isError = source.message.isError;
    if (Array.isArray(source.message?.content)) data.contentBlocks = source.message.content.length;
    if (reasons.has(source.reason?.kind)) data.reason = source.reason.kind;
    const error = source.reason?.kind === 'error' ? source.reason.error : source.error ?? source.failure;
    if (error !== undefined) {
      // Native compaction errors can be strings. Do not infer their meaning or
      // copy the provider's payload when no structured classification survived.
      data.diagnostic = diagnostic(error);
      data.details = details({ error: typeof error === 'string' ? error : error?.message, stack: error?.stack });
    }
    if (['request/context', 'model/selection', 'compaction/summary'].includes(row.type)) data.route = route(source);
    if (row.type === 'request/header') {
      const header = source.header ?? {};
      data.request = { source: 'native_header', wirePayload: 'not_recorded', config: config(header.config),
        adapterDefaults: Object.fromEntries(['maxTokens', 'reasoningEffort'].filter(key => header.adapterDefaults?.[key] === true).map(key => [key, true])),
        tools: { present: Array.isArray(header.tools), count: Array.isArray(header.tools) ? header.tools.length : 0,
          declarations: Array.isArray(header.tools) ? header.tools.map(item => ({ name: tool(item.name),
            ...(item.parameters ? { parameters: schema(item.parameters) } : {}) })) : [] } };
      if (typeof source.startsSeries === 'boolean') data.request.startsSeries = source.startsSeries;
      if (['initial', 'resume', 'change', 'series'].includes(source.reason)) data.request.reason = source.reason;
    }
    if (row.type === 'user/message' && source.source && typeof source.source === 'object') data.source = {
      senderSessionId: alias(source.source.senderSessionId), rpcId: alias(source.source.rpcId),
      kind: ['user', 'subagent-settled', 'agent-message', 'schedule', 'goal'].includes(source.source.kind) ? source.source.kind : 'other',
    };
    if (row.type === 'agent/inbox/spliced') {
      if (['next-step', 'next-turn'].includes(source.target)) data.target = source.target;
      if (Array.isArray(source.inserted)) data.inserted = source.inserted.map(item => ({ id: alias(item?.id) }));
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
      const output = details({ output: textOf(source.message?.content) });
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
            finish.details = details({ error: chunk.reason.failure.message, stack: chunk.reason.failure.stack });
          }
          summary.finishes.push(finish);
        }
      }
      data.stream = summary;
    }
    output.push({ type: types.has(row.type) ? row.type : 'other',
      ...(Number.isSafeInteger(row.seq) && row.seq >= 0 ? { seq: row.seq } : {}),
      ...(Number.isFinite(firstTime) && Number.isFinite(row.time) ? { elapsedMs: row.time - firstTime } : {}), data });
  }
  return [output[0], ...output.slice(1).reverse()].map(row => JSON.stringify(row)).join('\n') + '\n';
}
