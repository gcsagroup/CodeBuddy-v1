import { publicFailure } from './error-presentation.mjs';

const types = new Set([
  'turn/start', 'turn/end', 'step/start', 'step/end', 'user/message', 'assistant/message',
  'assistant/attempt', 'tool/call', 'tool/result', 'llm/retry', 'llm/retry-started',
  'compaction/start', 'compaction/end', 'compaction/summary', 'request/header', 'request/context',
  'system/message', 'session/title', 'session/title-llm-request', 'model/selection',
  'permission/preset', 'sandbox/mode', 'approval/policy', 'agent/inbox/spliced',
]);
const reasons = new Set(['completed', 'error', 'aborted', 'interrupted', 'forked', 'blocked', 'max-tokens']);
const numbers = ['turn', 'step', 'attempt', 'retry', 'maxRetries', 'delayMs', 'inputTokens',
  'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens'];

// This is a shareable observation, never a session archive or a replay input.
// Allowlist fields instead of trying to recognise secrets inside arbitrary prose.
export function sessionLogDiagnostics(text) {
  let rows;
  try { rows = text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
  catch { throw new Error('无法读取会话诊断；本机原始历史未修改。'); }
  const firstTime = rows.find(row => Number.isFinite(row.time))?.time;
  const aliases = new Map();
  const alias = value => {
    if (typeof value !== 'string') return undefined;
    if (!aliases.has(value)) aliases.set(value, `ref-${aliases.size + 1}`);
    return aliases.get(value);
  };
  const output = [{ type: 'diagnostic-export', revision: 'codebuddy-safe-v1',
    restorable: false, eventCount: Math.max(0, rows.length - 1) }];
  for (const row of rows.slice(1)) {
    const source = row.data ?? {}, data = {};
    for (const key of numbers)
      if (Number.isSafeInteger(source[key]) && source[key] >= 0) data[key] = source[key];
    for (const key of ['callId', 'attemptId', 'id', 'messageId']) {
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
      const safe = error?.code === 'TOOL_OUTCOME_UNKNOWN'
        ? { code: 'TOOL_OUTCOME_UNKNOWN', message: '工具执行中断，结果未知；请先核对外部状态，不要盲目重试。' }
        : publicFailure(typeof error === 'object' ? error : {});
      data.diagnostic = safe;
    }
    output.push({ type: types.has(row.type) ? row.type : 'other',
      ...(Number.isSafeInteger(row.seq) && row.seq >= 0 ? { seq: row.seq } : {}),
      ...(Number.isFinite(firstTime) && Number.isFinite(row.time) ? { elapsedMs: row.time - firstTime } : {}), data });
  }
  return output.map(row => JSON.stringify(row)).join('\n') + '\n';
}
