import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';

await import('./sdk-budget-contract.mjs');

// Optional error.info diagnostics only. Do not change native outcome, approval,
// cancellation or retry decisions. Remove when upstream preserves safe causes.
function safeToolCauses(error) {
  const allowed = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET',
    'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'EACCES', 'EPERM',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID',
    'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER']);
  const pending = [error], seen = new Set(), causes = [];
  while (pending.length && seen.size < 8) {
    const value = pending.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    try {
      if (allowed.has(value.code) && !causes.some(item => item.code === value.code))
        causes.push({ code: value.code });
      if (value.cause) pending.push(value.cause);
      if (Array.isArray(value.errors)) pending.push(...value.errors.slice(0, 4));
    } catch { /* Diagnostic getters must never replace the original failure. */ }
  }
  return causes;
}

const name = '@deepseek-ai/dsh-tools';
const url = import.meta.resolve(name);
const source = readFileSync(new URL(url), 'utf8');
const hash = 'c427f5bf2162a5afb13bf3cc99b4df38e93f46980836d8e1d414a612181567cc';
if (createHash('sha256').update(source).digest('hex') !== hash)
  throw new Error('Review the pinned native tool error diagnostic contract.');
const previous = 'const info = errorInfo(error);\n\tconst message = errorMessage(error);';
if (source.split(previous).length !== 2) throw new Error('Native tool error diagnostic seam changed.');
const replacement = source.replace(previous, `const causes = (${safeToolCauses.toString()})(error);
\tconst info = causes.length ? { ...errorInfo(error), causes } : errorInfo(error);
\tconst message = errorMessage(error) + (causes.length ? ' [transport: ' + causes.map(item => item.code).join(', ') + ']' : '');`);
let applied = false;
const hook = registerHooks({ load(loadedUrl, context, next) {
  const result = next(loadedUrl, context);
  if (loadedUrl !== url) return result;
  if (Buffer.from(result.source).toString('utf8') !== source)
    throw new Error('Native tools changed while installing diagnostics.');
  applied = true;
  return { ...result, source: replacement };
} });
try {
  await import(name);
  if (!applied) throw new Error('Load the tool error contract before native tools.');
} finally { hook.deregister(); }
