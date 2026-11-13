const codes = new Set([
  'SESSION_BUSY',
  'UNKNOWN_FAILURE',
  'QUOTA',
  'ACCOUNT_QUOTA',
  'AUTH',
  'INVALID_CREDENTIAL',
  'RATE_LIMIT',
  'SERVER',
  'TRANSPORT',
  'TIMEOUT',
  'PI_AI_ERROR',
  'EMPTY_RESPONSE',
  'OUTPUT_TRUNCATED',
  'OUTPUT_LIMIT_REACHED',
  'OUTPUT_LENGTH_STOP',
  'INVALID_OUTPUT_BUDGET',
  'CONTEXT_WINDOW_EXCEEDED',
  'LOCAL_OUTPUT_BUDGET_EXHAUSTED',
  'COMPACTION_OUTPUT_BUDGET_EXHAUSTED',
  'COMPACTION_NOT_SMALLER',
  'COMPACTION_EMPTY_SUMMARY',
  'COMPACTION_TARGET_WINDOW_EXCEEDED',
  'MAX_TOKENS',
  'NO_ADAPTER',
  'UNKNOWN_PROVIDER',
  'UNKNOWN_MODEL',
  'MODEL_NOT_FOUND',
  'MALFORMED_RESPONSE',
  'STREAM_CLOSED',
  'INVALID_REQUEST',
  'UNSUPPORTED_CONTENT',
  'UNSUPPORTED_OPTION',
  'ABORTED',
  ...[
    'unsupported_engine',
    'invalid_url',
    'invalid_header',
    'api_key_required',
    'endpoint_unreachable',
    'invalid_credentials',
    'permission_denied',
    'response_too_large',
    'invalid_response',
    'no_models',
    'model_unavailable',
    'model_list_unavailable',
    'credentials_not_verified',
    'tools_unsupported',
    'invalid_output_budget',
  ].map((code) => `custom_provider_${code}`),
]);
const transports = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export interface FailureDiagnostic {
  code: string;
  httpStatus?: number;
  transportCodes?: string[];
}

// Presentation validation only: no error text, URLs, headers or model inputs.
// An invalid optional diagnostic must never invalidate a terminal/retry record.
export function parseFailureDiagnostic(value: unknown): FailureDiagnostic | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Record<string, unknown>;
  if (typeof data.code !== 'string' || !codes.has(data.code)) return undefined;
  const transportCodes = Array.isArray(data.transportCodes)
    ? [
        ...new Set(
          data.transportCodes.slice(0, 64).filter(
            (code): code is string => typeof code === 'string' && transports.has(code)
          )
        ),
      ].slice(0, 4)
    : [];
  return {
    code: data.code,
    ...(typeof data.httpStatus === 'number' &&
    Number.isInteger(data.httpStatus) &&
    data.httpStatus >= 100 &&
    data.httpStatus <= 599
      ? { httpStatus: data.httpStatus }
      : {}),
    ...(transportCodes.length ? { transportCodes } : {}),
  };
}

export function formatFailureDiagnostic(value: unknown): string | undefined {
  const data = parseFailureDiagnostic(value);
  return data
    ? [
        data.code,
        ...(data.httpStatus ? [`HTTP ${data.httpStatus}`] : []),
        ...(data.transportCodes ?? []),
      ].join('; ')
    : undefined;
}
