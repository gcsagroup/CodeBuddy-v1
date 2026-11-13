// Export-only scrubbing. Never use this projection as a recovery input.
import { isIP } from 'node:net';
import { stripVTControlCharacters } from 'node:util';
const sensitiveKeys = new Set(['authorization', 'proxyauthorization', 'cookie', 'setcookie', 'apikey',
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'password', 'passwd', 'clientsecret', 'privatekey', 'secret',
  'username', 'email', 'phone', 'phonenumber', 'accountid', 'userid', 'tenantid']);
const canonical = key => key.toLowerCase().replace(/[-_]/g, '');
const publicHosts = new Set(['localhost', '127.0.0.1', '[::1]', 'ollama.com', 'api.openai.com',
  'api.deepseek.com', 'api.anthropic.com', 'api.moonshot.cn', 'api.minimax.io', 'open.bigmodel.cn']);
const technicalQuery = new Set(['model', 'stream', 'max_tokens', 'max_output_tokens', 'temperature',
  'top_p', 'reasoning_effort', 'api-version', 'version']);
const publicHeaders = new Set(['content-type', 'accept', 'user-agent', 'x-request-id', 'request-id',
  'traceparent', 'tracestate', 'retry-after', 'date', 'content-length', 'openai-beta',
  'anthropic-version', 'anthropic-beta', 'x-model', 'x-api-version']);
const publicHeader = key => publicHeaders.has(key.toLowerCase()) || /^x-ratelimit-(limit|remaining|reset)-(requests|tokens)$/i.test(key);
const argumentControls = new Set(['offset', 'limit', 'timeout', 'timeout_ms', 'max_results',
  'line', 'column', 'page', 'recursive', 'replace_all', 'dry_run']);
const privateFields = new Set(['messages', 'prompt', 'input', 'content', 'reasoning', 'summary',
  'rawoutput', 'replaystate', 'requestbody', 'responsebody']);

// Use the same representation for sensitive-value discovery and output. A
// second JSON encoding must not make a header visible only after the scan.
function decodeLayer(text) {
  return text.replace(/\\u([0-9a-f]{4})|\\(["\\/])/gi, (_match, code, character) => code ? String.fromCharCode(parseInt(code, 16)) : character);
}
function normaliseText(value) {
  let text = value;
  for (let depth = 0; depth < 4; depth++) {
    const decoded = decodeLayer(text);
    if (decoded === text) break;
    text = decoded;
  }
  return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

// Locate a quoted/compound JSON value without interpreting provider prose.
function valueEnd(text, start) {
  let quote, escaped = false, depth = 0;
  for (let at = start; at < text.length; at++) {
    const char = text[at];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) { quote = undefined; if (!depth) return at + 1; }
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '[' || char === '{') depth++;
    else if (char === ']' || char === '}') { if (--depth <= 0) return at + 1; }
    else if (!depth && /[,;\r\n]/.test(char)) return at;
  }
  return text.length;
}

function removeBodyEchoes(text) {
  const field = /\b(messages|prompt|input|content|reasoning|summary|raw[_-]?output|replay[_-]?state|request[_-]?body|response[_-]?body)["']?\s*[:=]\s*/gi;
  let match, end = 0, output = '';
  while ((match = field.exec(text))) {
    if (match.index < end) continue;
    const start = field.lastIndex;
    const quotedKey = /["']/.test(text[match.index - 1] ?? '');
    // "Invalid input: expected text" describes a failure; it is not an
    // echoed request body. Require assignment or a structured/quoted value.
    if (!quotedKey && !match[0].includes('=') && !/[\[{'"]/.test(text[start] ?? '')) continue;
    output += text.slice(end, start) + '"[content removed]"';
    end = valueEnd(text, start);
    field.lastIndex = end;
  }
  return output ? output + text.slice(end) : text;
}

export function diagnosticRedaction(rows) {
  const names = new Map(), roots = new Set(), privateHosts = new Set(), secrets = new Set(), privateValues = new Set();
  let scanIncomplete = false, privateTextIncomplete = false, privateCharacters = 0;
  const rememberSecret = value => {
    if (!value) return;
    if (value.length > 8192 || secrets.size > 512) scanIncomplete = true;
    else secrets.add(normaliseText(value));
  };
  const alias = (value, kind = 'ref') => {
    if (typeof value !== 'string') return undefined;
    const key = kind + '\0' + value;
    if (!names.has(key)) names.set(key, `${kind}-${names.size + 1}`);
    return names.get(key);
  };
  const rememberPrivate = value => {
    if (typeof value !== 'string' || value.length < 8) return;
    const text = normaliseText(value);
    if (privateValues.has(text)) return;
    // Body matching has a separate budget: reaching it must not erase models,
    // IDs, event types or other independently checked technical fields.
    if (privateCharacters + text.length > 4194304) privateTextIncomplete = true;
    else { privateValues.add(text); privateCharacters += text.length; }
  };
  // Collect known credential values from the journal, not today's connections.
  // This also catches a credential later echoed without its field name.
  const scan = (value, depth = 0, privateSection = '') => {
    if (!value || typeof value !== 'object') return;
    if (depth > 32) { scanIncomplete = true; return; }
    for (const [key, item] of Object.entries(value)) {
      const credential = sensitiveKeys.has(canonical(key)) || /(?:apikey|token|password|secret|credential)$/.test(canonical(key));
      const hidden = (privateSection === 'headers' && !publicHeader(key)) || privateSection === 'credentials' || credential;
      if (hidden && typeof item === 'string' && item.length) {
        rememberSecret(item);
        const authorization = /^(Bearer|Basic)\s+(\S+)$/i.exec(normaliseText(item));
        if (authorization) {
          rememberSecret(authorization[2]);
          if (authorization[1].toLowerCase() === 'basic' && authorization[2].length <= 8192) {
            const decoded = Buffer.from(authorization[2], 'base64').toString('utf8'), separator = decoded.indexOf(':');
            if (separator >= 0) { rememberSecret(decoded.slice(0, separator)); rememberSecret(decoded.slice(separator + 1)); }
          }
        }
      }
      if (hidden && typeof item === 'number' && Number.isFinite(item)) secrets.add(String(item));
      if (typeof item === 'string') {
        if (key === 'arguments') {
          if (item.length > 1048576) scanIncomplete = true;
          else { try { scan(JSON.parse(item), depth + 1, hidden ? 'credentials' : ''); } catch { /* Invalid JSON is reported by the argument shape. */ } }
        }
        if (key === 'cwd') roots.add(item.replaceAll('\\', '/').replace(/\/$/, ''));
        if (['url', 'baseUrl', 'apiUrl'].includes(key)) {
          try {
            const url = new URL(item);
            if (!publicHosts.has(url.hostname)) privateHosts.add(url.hostname);
            const authentication = [url.username, url.password].map(raw => { try { return decodeURIComponent(raw); } catch { return raw; } });
            for (const raw of [...authentication, ...[...url.searchParams].filter(([name]) => !technicalQuery.has(name)).map(([, value]) => value)]) {
              if (!raw) continue;
              rememberSecret(raw);
            }
          } catch { /* Relative locations have no URL authentication fields. */ }
        }
        // An error may embed a JSON response, including authentication headers.
        // Collect those named values before rendering any exported free text.
        if (['message', 'stack'].includes(key)) scanText(item, depth + 1);
      } else scan(item, depth + 1, hidden ? 'credentials' : ['headers', 'requestheaders', 'customheaders'].includes(canonical(key)) ? 'headers' : privateSection);
    }
  };
  function scanText(value, depth) {
    if (depth > 32) { scanIncomplete = true; return; }
    if (value.length > 32768) return; // Oversized excerpts are never emitted.
    const text = stripVTControlCharacters(value), token = /[\[{]|(?<!\\)"/g;
    const gaps = [];
    let match, cursor = 0, invalidFragments = 0;
    while ((match = token.exec(text))) {
      const end = valueEnd(text, match.index);
      let parsed;
      try { parsed = JSON.parse(text.slice(match.index, end)); }
      catch {
        if (++invalidFragments >= 32) { scanIncomplete = true; return; }
        continue;
      }
      gaps.push(text.slice(cursor, match.index));
      cursor = end; token.lastIndex = end;
      if (typeof parsed === 'string') scanText(parsed, depth + 1);
      else scan(parsed, depth + 1);
    }
    gaps.push(text.slice(cursor));
    // Preserve valid JSON escapes above. Decode only unmatched regions; global
    // unescaping would turn a legal quoted credential into invalid JSON.
    for (const gap of gaps) {
      const decoded = decodeLayer(gap);
      if (decoded !== gap) scanText(decoded, depth + 1);
    }
  }
  const privateBlocks = blocks => {
    if (typeof blocks === 'string') rememberPrivate(blocks);
    if (Array.isArray(blocks)) {
      const texts = blocks.filter(block => typeof block?.text === 'string').map(block => block.text);
      for (const text of texts) rememberPrivate(text);
      rememberPrivate(texts.join('\n'));
    }
  };
  for (const row of rows) {
    scan(row);
    if (['user/message', 'assistant/message', 'system/message'].includes(row.type)) privateBlocks(row.data?.message?.content ?? row.data?.content);
    if (row.type === 'compaction/summary') { privateBlocks(row.data?.summary); privateBlocks(row.data?.rawOutput); }
    if (row.type === 'assistant/attempt' && Array.isArray(row.data?.stream))
      for (const record of row.data.stream) if (['text-chunks', 'reasoning-chunks'].includes(record?.type))
        privateBlocks((record.texts ?? []).map(text => ({ text })));
    if (row.type === 'tool/call') {
      let args = row.data?.arguments;
      if (typeof args === 'string' && args.length <= 1048576) { try { args = JSON.parse(args); } catch { args = undefined; } }
      if (args && typeof args === 'object') for (const [key, value] of Object.entries(args)) if (privateFields.has(canonical(key))) rememberPrivate(value);
    }
  }
  const capacityExceeded = scanIncomplete || secrets.size > 512;
  const pathText = raw => {
    const value = raw.replaceAll('\\', '/');
    for (const root of roots) {
      const windows = /^[a-z]:\//i.test(root) || root.startsWith('//');
      const compared = windows ? value.toLowerCase() : value, prefix = windows ? root.toLowerCase() : root;
      if (compared === prefix || compared.startsWith(prefix + '/')) return '[workspace]' + value.slice(root.length);
    }
    const slash = value.lastIndexOf('/');
    return '[' + alias(value.slice(0, slash), 'path') + ']/' + value.slice(slash + 1);
  };
  const urlText = raw => {
    try {
      const url = new URL(raw), host = publicHosts.has(url.hostname) ? url.hostname : '[' + alias(url.hostname, 'host') + ']';
      const query = [...url.searchParams].map(([key, value]) => `${key}=${technicalQuery.has(key) && value.length <= 256 ? value : '[redacted]'}`).join('&');
      return `${url.protocol}//${host}${url.port ? ':' + url.port : ''}${url.pathname}${query ? '?' + query : ''}${url.hash ? '#[redacted]' : ''}`;
    } catch { return '[invalid URL]'; }
  };
  const remaining = { error: 65536, output: 65536 };
  const clean = (value, includePrivate = true) => {
    let text = normaliseText(value);
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
    for (const secret of includePrivate ? [...secrets, ...privateValues] : secrets) {
      const needle = secret.replace(/[\s\p{Cf}]/gu, '');
      if (!needle) continue;
      for (let at = joined.indexOf(needle); at >= 0; at = joined.indexOf(needle, at + 1)) {
        if (spans.length >= 8192) return '[text omitted: redaction match limit]';
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
    text = removeBodyEchoes(text)
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[private key removed]')
      .replace(/\b(?:Bearer|Basic)\s+[^\s,"';]+/gi, '[authorization removed]')
      .replace(/(\b(?:(?:x[-_])?(?:api[_-]?key|auth[_-]?token)|access[_-]?token|refresh[_-]?token|id[_-]?token|password|passwd|client[_-]?secret|authorization|cookie|set-cookie|token|secret|username|email|phone(?:[_-]?number)?|account[_-]?id|user[_-]?id|tenant[_-]?id)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&\r\n}]+)/gi, '$1[redacted]');
    text = text
      .replace(/https?:\/\/[^\s<>"')]+/gi, urlText)
      .replace(/(?<![\w])(?:[a-zA-Z]:[\\/]|\\\\)[^\r\n<>"|]*?(?=\s+(?:at|with|for|and)\b|[\r\n<>"|]|$)/g, pathText)
      .replace(/(?<![\w:\]/])\/(?!\/)(?:[^\s<>"')/]+\/)+[^\s<>"')]+/g, pathText)
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email removed]')
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, value => value.startsWith('127.') ? value : '[address removed]')
      .replace(/\[?[a-f0-9]*:[a-f0-9:.%]+\]?/gi, value => {
        const address = value.replace(/^\[|\]$/g, '');
        return isIP(address) === 6 && address !== '::1' ? '[address removed]' : value;
      })
      .replace(/\b(?:sk-|gh[pousr]_)[a-zA-Z0-9_-]{20,}\b/g, '[credential removed]');
    for (const host of privateHosts) {
      const pattern = new RegExp(host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      text = text.replace(pattern, '[' + alias(host, 'host') + ']');
    }
    return text;
  };
  const technical = value => {
    if (typeof value !== 'string') return undefined;
    if (value.length > 8192 || capacityExceeded) return '[text omitted: redaction capacity exceeded]';
    return clean(value, false);
  };
  const excerpt = (value, channel = 'error') => {
    if (typeof value !== 'string' || !value) return undefined;
    if (capacityExceeded || privateTextIncomplete) return { text: '[excerpt omitted: redaction capacity exceeded]', truncated: true };
    const available = Math.min(remaining[channel], 32768);
    if (value.length > available) return { text: '[excerpt omitted: text exceeds redaction budget]', truncated: true };
    remaining[channel] -= value.length;
    const text = clean(value);
    return { text: text.slice(0, 4096), truncated: text.length > 4096 || text.startsWith('[text omitted:') };
  };
  const shape = (value, depth = 0, key = '') => {
    if (value === null) return { type: 'null' };
    if (Array.isArray(value)) return { type: 'array', length: value.length,
      ...(depth < 3 && value.length ? { item: shape(value[0], depth + 1) } : {}) };
    if (typeof value === 'string') return { type: 'string', length: value.length,
      ...(['path', 'file_path'].includes(key) ? { value: technical(value) } : {}) };
    if (typeof value !== 'object') return { type: typeof value,
      ...(argumentControls.has(key) && (typeof value === 'boolean' || Number.isFinite(value)) ? { value } : {}) };
    const entries = Object.entries(value);
    return { type: 'object', count: entries.length, ...(depth < 3 ? {
      fields: entries.slice(0, 32).map(([key, item]) => ({ field: technical(key), ...shape(item, depth + 1, key) })),
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
    for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
      'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'])
      if (Number.isFinite(value[key])) result[key] = value[key];
    for (const key of ['additionalProperties', 'uniqueItems']) if (typeof value[key] === 'boolean') result[key] = value[key];
    if (Array.isArray(value.required)) result.required = value.required.filter(x => typeof x === 'string').map(technical);
    if (Array.isArray(value.enum)) result.enumCount = value.enum.length;
    if (depth < 3 && value.properties && typeof value.properties === 'object') {
      result.properties = Object.entries(value.properties).slice(0, 64).map(([key, item]) => ({ field: technical(key), ...schema(item, depth + 1) }));
      if (Object.keys(value.properties).length > 64) result.truncated = true;
    }
    if (depth < 3 && value.items) result.items = schema(value.items, depth + 1);
    return result;
  };
  const headers = value => value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => publicHeader(key)).map(([key, value]) =>
      [key, typeof value === 'number' ? value : technical(value)])) : undefined;
  return { technical, tool: technical, argumentsShape, schema, excerpt, headers };
}
