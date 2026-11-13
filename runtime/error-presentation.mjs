import { requestFailureAdvice } from './work-status.mjs';

const nativeCodes = new Set(['QUOTA', 'ACCOUNT_QUOTA', 'AUTH', 'INVALID_CREDENTIAL', 'RATE_LIMIT', 'SERVER', 'TRANSPORT', 'TIMEOUT',
  'PI_AI_ERROR', 'EMPTY_RESPONSE', 'OUTPUT_TRUNCATED', 'OUTPUT_LIMIT_REACHED', 'OUTPUT_LENGTH_STOP', 'INVALID_OUTPUT_BUDGET',
  'CONTEXT_WINDOW_EXCEEDED', 'LOCAL_OUTPUT_BUDGET_EXHAUSTED', 'COMPACTION_OUTPUT_BUDGET_EXHAUSTED',
  'COMPACTION_NOT_SMALLER', 'COMPACTION_EMPTY_SUMMARY', 'COMPACTION_TARGET_WINDOW_EXCEEDED', 'MAX_TOKENS',
  'NO_ADAPTER', 'UNKNOWN_PROVIDER', 'UNKNOWN_MODEL', 'MODEL_NOT_FOUND', 'MALFORMED_RESPONSE', 'STREAM_CLOSED',
  'INVALID_REQUEST', 'UNSUPPORTED_CONTENT', 'UNSUPPORTED_OPTION', 'ABORTED']);
const transportCodes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID']);
const providerCodes = new Set(['unsupported_engine', 'invalid_url', 'invalid_header', 'api_key_required', 'endpoint_unreachable',
  'invalid_credentials', 'permission_denied', 'response_too_large', 'invalid_response', 'no_models', 'model_unavailable',
  'model_list_unavailable', 'credentials_not_verified', 'tools_unsupported', 'invalid_output_budget'].map(code => 'custom_provider_' + code));
const providerKinds = new Map([
  ['custom_provider_api_key_required', 'AUTH'], ['custom_provider_invalid_credentials', 'AUTH'],
  ['custom_provider_credentials_not_verified', 'AUTH'],
  ['custom_provider_permission_denied', 'AUTH'], ['custom_provider_endpoint_unreachable', 'TRANSPORT'],
  ['custom_provider_invalid_response', 'MALFORMED_RESPONSE'], ['custom_provider_tools_unsupported', 'UNSUPPORTED_OPTION'],
  ['custom_provider_invalid_output_budget', 'INVALID_OUTPUT_BUDGET'],
]);
const localMessages = new Map([['SESSION_BUSY', '当前对话仍在执行，请先停止本轮，再切换模型；当前模型和执行状态未改变。']]);
const validStatus = value => Number.isInteger(value) && value >= 100 && value <= 599;
const field = (value, key) => { try { return value?.[key]; } catch { return undefined; } };
const visionMessages = {
  vision_not_configured: '当前模型尚未确认支持图片，请切换模型或配置备用识图模型。',
  provider_unavailable: '备用识图连接已不可用，请在设置中重新选择。',
  model_unavailable: '备用识图模型不可用，请在设置中重新选择。',
  capability_unavailable: '暂时无法核实备用识图模型，请检查连接后重试。',
  configuration_changed: '识图设置刚发生变化，请重新确认后保存。',
  image_limit: '本次识图的图片数量或总大小超过限制，请减少图片后重试。',
  image_invalid: '图片数据、格式或大小不符合识图限制，请重新添加图片。',
  query_limit: '本次识图附带的文字过长，请缩短后重试。',
  image_not_supported: '所选备用模型尚未确认支持图片，请重新选择支持图片的模型。',
  vision_timeout: '图片识别超时，请稍后重试或更换备用识图模型。',
  vision_failed: '备用识图模型暂时无法完成识别，请检查连接或更换模型。',
  vision_output_limit: '备用识图返回内容过长，未采用该结果。',
  vision_invalid_result: '备用识图模型尝试执行其他操作，已拒绝采用该结果。',
  vision_incomplete: '图片识别未正常完成，没有将未完成的内容交给主模型。',
  vision_empty: '备用识图模型没有返回图片说明，请重试或更换模型。',
};

// A display projection only: never mutate a native failure or decide retries.
// No provider prose, request/response payloads, headers, URLs or paths escape.
export function publicFailure(error, observation = {}) {
  let code, status, providerCode;
  const transport = new Set(), seen = new Set(), queue = [error];
  for (let i = 0; i < queue.length && seen.size < 8; i++) {
    const value = queue[i];
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    try {
      if (!code && (nativeCodes.has(value.code) || localMessages.has(value.code))) code = value.code;
      if (!code && (nativeCodes.has(value.data?.code) || localMessages.has(value.data?.code))) code = value.data.code;
      if (!providerCode && providerCodes.has(value.code)) providerCode = value.code;
      if (transportCodes.has(value.code)) transport.add(value.code);
      if (!providerCode && providerCodes.has(value.data?.code)) providerCode = value.data.code;
      for (const candidate of [value.status, value.httpStatus, value.data?.httpStatus])
        if (status === undefined && validStatus(candidate)) status = candidate;
      if (Array.isArray(value.transportCodes))
        for (const item of value.transportCodes.slice(0, 64)) if (transportCodes.has(item)) transport.add(item);
      if (value.cause) queue.push(value.cause);
    } catch { /* Diagnostic getters are optional, not an execution failure. */ }
  }
  const observedStatus = field(observation, 'status'), observedTransport = field(observation, 'transportCodes');
  if (status === undefined && validStatus(observedStatus)) status = observedStatus;
  if (Array.isArray(observedTransport))
    for (const value of observedTransport.slice(0, 64)) if (transportCodes.has(value)) transport.add(value);
  code ??= providerKinds.get(providerCode) ?? (transport.size ? 'TRANSPORT' : 'UNKNOWN_FAILURE');
  const identity = providerCode ?? code;
  const diagnostic = { code: identity, ...(status === undefined ? {} : { httpStatus: status }),
    ...(transport.size ? { transportCodes: [...transport].slice(0, 4) } : {}) };
  let message;
  if (localMessages.has(code)) message = localMessages.get(code);
  else if (code === 'ABORTED') message = '操作已中止。已提交的记录保留，请核对当前状态后继续。';
  else if (['COMPACTION_NOT_SMALLER', 'COMPACTION_EMPTY_SUMMARY', 'COMPACTION_TARGET_WINDOW_EXCEEDED'].includes(code)) {
    message = ({ COMPACTION_NOT_SMALLER: '模型未生成更小的有效摘要。', COMPACTION_EMPTY_SUMMARY: '模型未返回可提交的摘要。',
      COMPACTION_TARGET_WINDOW_EXCEEDED: '压缩后仍不能放进当前模型窗口。' })[code] + '历史及已提交检查点保留；请检查压缩模型或缩短本轮输入后重试。';
  } else if (providerCode && code === 'UNKNOWN_FAILURE') message = '模型连接配置或服务验证失败。请检查 API 地址、模型和输入选项后重试。';
  else if (code === 'UNKNOWN_FAILURE' && status === undefined)
    message = '请求未能完成，运行时未提供可公开的具体原因。请检查当前连接，必要时切换模型后继续；不要直接分享原始会话或服务响应。';
  else message = requestFailureAdvice({ code, ...(status === undefined ? {} : { status }) }, { transportCodes: [...transport] });
  return { ...diagnostic, message: message + ` [${identity}${status === undefined ? '' : '; HTTP ' + status}${transport.size ? '; ' + [...transport].slice(0, 4).join(', ') : ''}]` };
}

export function publicRpcError(error, method) {
  const failure = publicFailure(error);
  const originalData = field(error, 'data'), originalCode = field(error, 'code');
  const reason = field(originalData, 'reason');
  const safeReason = typeof reason === 'string' ? reason : undefined;
  const rpcCode = Number.isInteger(originalCode) ? originalCode : -32603;
  // Preserve existing business error contracts outside model/turn failures.
  const guarded = failure.code !== 'UNKNOWN_FAILURE' || failure.httpStatus !== undefined || ['session/prompt', 'session/set_config_option'].includes(method);
  if (!guarded) return { code: rpcCode, message: field(error, 'message'), data: originalData };
  const data = providerCodes.has(failure.code) || localMessages.has(failure.code) ? { code: failure.code, ...(failure.httpStatus ? { httpStatus: failure.httpStatus } : {}) }
    : field(originalData, 'kind') === 'vision_error' ? { kind: 'vision_error',
      ...(safeReason && Object.hasOwn(visionMessages, safeReason) ? { reason: safeReason } : {}) }
    : ['recipe_params_cancelled', 'credits_exhausted'].includes(safeReason) ? { reason: safeReason } : undefined;
  const { message, ...diagnostic } = failure;
  return { code: rpcCode, message: data?.kind === 'vision_error' ? visionMessages[data.reason] ?? '图片识别未完成，请检查识图设置后重试。' : message,
    data: { ...data, diagnostic } };
}
