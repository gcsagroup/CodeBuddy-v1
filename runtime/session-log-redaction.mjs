// Export-only scrubbing. Never use this projection as a recovery input.
import { isIP } from 'node:net';
import { stripVTControlCharacters } from 'node:util';
const sensitiveKeys = new Set(['authorization', 'proxyauthorization', 'cookie', 'setcookie', 'apikey',
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'password', 'passwd', 'clientsecret', 'privatekey', 'secret']);
const canonical = key => key.toLowerCase().replace(/[-_]/g, '');
const builtinTools = new Set(['read', 'write', 'edit', 'pwsh', 'bash', 'grep', 'glob', 'ls',
  'subagent_explorer', 'subagent_coder', 'subagent_tester', 'send_message']);
const parameterNames = new Set(['path', 'file_path', 'content', 'command', 'pattern', 'offset', 'limit',
  'old_string', 'new_string', 'replace_all', 'agent_id', 'message', 'task', 'description', 'timeout']);

export function diagnosticRedaction(rows) {
  const names = new Map(), replacements = new Map(), secrets = new Set();
  let scanIncomplete = false;
  const rememberSecret = value => {
    if (!value) return;
    if (value.length > 8192 || secrets.size > 512) scanIncomplete = true;
    else secrets.add(value);
  };
  const alias = (value, kind = 'ref') => {
    if (typeof value !== 'string') return undefined;
    const key = kind + '\0' + value;
    if (!names.has(key)) names.set(key, `${kind}-${names.size + 1}`);
    if (value.length >= 4) replacements.set(value, names.get(key));
    return names.get(key);
  };
  const tool = value => builtinTools.has(value) ? value : alias(value, 'tool');
  const field = value => parameterNames.has(value) ? value : alias(value, 'field');
  // Collect known credential values from the journal, not today's connections.
  // This also catches a credential later echoed without its field name.
  const scan = (value, depth = 0, privateSection = false) => {
    if (!value || typeof value !== 'object') return;
    if (depth > 32) { scanIncomplete = true; return; }
    for (const [key, item] of Object.entries(value)) {
      const hidden = privateSection || sensitiveKeys.has(canonical(key)) || ['headers', 'requestheaders', 'customheaders', 'env', 'credentials'].includes(canonical(key));
      if (hidden && typeof item === 'string' && item.length) {
        rememberSecret(item);
        const authorization = /^(Bearer|Basic)\s+(\S+)$/i.exec(item);
        if (authorization) {
          rememberSecret(authorization[2]);
          if (authorization[1].toLowerCase() === 'basic' && authorization[2].length <= 8192) {
            const decoded = Buffer.from(authorization[2], 'base64').toString('utf8'), separator = decoded.indexOf(':');
            if (separator >= 0) { rememberSecret(decoded.slice(0, separator)); rememberSecret(decoded.slice(separator + 1)); }
          }
        }
      }
      if (hidden && typeof item === 'number' && Number.isFinite(item)) secrets.add(String(item));
      if (['properties', 'arguments'].includes(key) && item && typeof item === 'object' && !Array.isArray(item))
        for (const name of Object.keys(item)) field(name);
      if (typeof item === 'string') {
        if (key === 'arguments') {
          if (item.length > 1048576) scanIncomplete = true;
          else { try { scan(JSON.parse(item), depth + 1, hidden); } catch { /* Invalid JSON is reported by the argument shape. */ } }
        }
        if (['provider', 'model'].includes(key)) alias(item, key);
        else if (['id', 'callId', 'toolCallId', 'messageId', 'attemptId', 'requestId', 'compactionId', 'sourceCommandId', 'parentSession', 'senderSessionId', 'childId', 'rpcId'].includes(key)) alias(item);
        else if (['cwd', 'path', 'file_path', 'url', 'baseUrl', 'apiUrl'].includes(key)) alias(item, 'location');
        else if (key === 'name') tool(item);
        if (['url', 'baseUrl', 'apiUrl'].includes(key)) {
          try {
            const url = new URL(item);
            if (url.hostname) alias(url.hostname, 'endpoint');
            const authentication = [url.username, url.password].map(raw => { try { return decodeURIComponent(raw); } catch { return raw; } });
            for (const raw of [...authentication, ...url.searchParams.values()]) {
              if (!raw) continue;
              rememberSecret(raw);
            }
          } catch { /* Relative locations have no URL authentication fields. */ }
        }
      } else scan(item, depth + 1, hidden);
    }
  };
  for (const row of rows) scan(row);
  const capacityExceeded = scanIncomplete || replacements.size > 4096 || secrets.size > 512;
  const substitutions = capacityExceeded ? [] : [...replacements].sort((a, b) => b[0].length - a[0].length);
  const remaining = { error: 65536, output: 65536 };
  const excerpt = (value, channel = 'error') => {
    if (typeof value !== 'string' || !value) return undefined;
    if (capacityExceeded) return { text: '[excerpt omitted: redaction capacity exceeded]', truncated: true };
    const available = Math.min(remaining[channel], 32768);
    // Do not cut a credential before scrubbing: a visible prefix is still a leak.
    if (value.length > available) return { text: '[excerpt omitted: text exceeds redaction budget]', truncated: true };
    remaining[channel] -= value.length;
    let text = value, truncated = false;
    // Provider messages can contain JSON nested inside a JSON string. Normalise
    // recognised escapes before matching sensitive fields, without executing it.
    for (let depth = 0; depth < 4; depth++) {
      const decoded = text.replace(/\\u([0-9a-f]{4})|\\(["\\/])/gi, (_match, code, character) => code ? String.fromCharCode(parseInt(code, 16)) : character);
      if (decoded === text) break;
      text = decoded;
    }
    // Normalise terminal rendering before matching: later removal could join
    // two harmless-looking fragments back into the original credential.
    text = stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    // Credential echoes may be split across content blocks or lines. Match the
    // joined values on the same original text, then merge overlaps before
    // replacement. Replacing a shorter secret first can expose a longer suffix.
    const positions = [], characters = [];
    let offset = 0;
    for (const character of text) {
      if (!/[\s\p{Cf}]/u.test(character)) {
        for (let unit = 0; unit < character.length; unit++) { positions.push(offset + unit); characters.push(character[unit]); }
      }
      offset += character.length;
    }
    const joined = characters.join(''), spans = [];
    for (const secret of secrets) {
      const needle = secret.replace(/[\s\p{Cf}]/gu, '');
      if (!needle) continue;
      for (let at = joined.indexOf(needle); at >= 0; at = joined.indexOf(needle, at + 1)) {
        if (spans.length >= 8192) return { text: '[excerpt omitted: redaction match limit]', truncated: true };
        spans.push([positions[at], positions[at + needle.length - 1] + 1]);
      }
    }
    if (spans.length) {
      spans.sort((a, b) => a[0] - b[0]);
      let end = 0, cleaned = '';
      for (const [start, stop] of spans) {
        if (start >= end) cleaned += text.slice(end, start) + '[redacted]';
        end = Math.max(end, stop);
      }
      text = cleaned + text.slice(end);
    }
    text = text
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[private key removed]')
      .replace(/\b(?:Bearer|Basic)\s+[^\s,"';]+/gi, '[authorization removed]')
      .replace(/\b(?:(?:x[-_])?(?:api[_-]?key|auth[_-]?token)|access[_-]?token|refresh[_-]?token|id[_-]?token|password|passwd|client[_-]?secret|authorization|cookie|set-cookie|token|secret)["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n}]+)/gi, '[credential removed]');
    for (const [value, replacement] of substitutions) text = text.split(value).join('[' + replacement + ']');
    text = text
      .replace(/https?:\/\/[^\s<>"')]+/gi, value => '[' + alias(value, 'endpoint') + ']')
      .replace(/(?:[a-zA-Z]:[\\/]|\\\\)[^\r\n<>"|]*?(?=\s+(?:at|with|for|and)\b|[\r\n<>"|]|$)/g, value => '[' + alias(value, 'path') + ']')
      .replace(/\/(?:Users|home|tmp|var|private|workspace|workspaces)\/[^\s<>"')]+/g, value => '[' + alias(value, 'path') + ']')
      .replace(/(?<![\w:])\/(?:[^\s<>"')/]+\/)+[^\s<>"')]+/g, value => '[' + alias(value, 'path') + ']')
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email removed]')
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[address removed]')
      .replace(/\[?[a-f0-9]*:[a-f0-9:.%]+\]?/gi, value => isIP(value.replace(/^\[|\]$/g, '')) === 6 ? '[address removed]' : value)
      .replace(/\b(?:sk-|gh[pousr]_)[a-zA-Z0-9_-]+\b/g, '[credential removed]')
      .replace(/\b[A-Za-z0-9_+/=-]{48,}\b/g, '[opaque value removed]');
    truncated ||= text.length > 4096;
    return { text: text.slice(0, 4096), truncated };
  };
  const shape = (value, depth = 0) => {
    if (value === null) return { type: 'null' };
    if (Array.isArray(value)) return { type: 'array', length: value.length,
      ...(depth < 3 && value.length ? { item: shape(value[0], depth + 1) } : {}) };
    if (typeof value === 'string') return { type: 'string', length: value.length };
    if (typeof value !== 'object') return { type: typeof value };
    const entries = Object.entries(value);
    return { type: 'object', count: entries.length, ...(depth < 3 ? {
      fields: entries.slice(0, 32).map(([key, item]) => ({ field: field(key), ...shape(item, depth + 1) })),
      ...(entries.length > 32 ? { truncated: true } : {}),
    } : {}) };
  };
  const argumentsShape = value => {
    if (typeof value !== 'string') return shape(value);
    if (value.length > 1048576) return { type: 'string', length: value.length, structure: 'size_limit' };
    try { return { ...shape(JSON.parse(value)), encodedCharacters: value.length }; }
    catch { return { type: 'invalid-json', length: value.length }; }
  };
  const schema = (value, depth = 0) => {
    if (!value || typeof value !== 'object') return { type: 'unknown' };
    const types = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
    const result = { type: types.includes(value.type) ? value.type : 'unknown' };
    if (Array.isArray(value.required)) result.required = value.required.filter(x => typeof x === 'string').map(field);
    if (Array.isArray(value.enum)) result.enumCount = value.enum.length;
    if (depth < 3 && value.properties && typeof value.properties === 'object') {
      result.properties = Object.entries(value.properties).slice(0, 64).map(([key, item]) => ({ field: field(key), ...schema(item, depth + 1) }));
      if (Object.keys(value.properties).length > 64) result.truncated = true;
    }
    if (depth < 3 && value.items) result.items = schema(value.items, depth + 1);
    return result;
  };
  return { alias, tool, argumentsShape, schema, excerpt };
}
