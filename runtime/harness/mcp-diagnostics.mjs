// Startup diagnostics only; never change invocation outcomes or retry ownership.
export function mcpDiagnostic(error, config = {}, stderr = '') {
  const messages = [], seen = new Set();
  for (let current = error; current && !seen.has(current) && seen.size < 4; current = current.cause) {
    seen.add(current);
    if (typeof current.message === 'string') messages.push(current.message);
  }
  let text = [...messages, stderr.slice(-8192)].filter(Boolean).join('\n');
  const secrets = [...Object.values(config.env ?? {}), ...Object.values(config.headers ?? {})];
  for (const value of secrets) {
    if (typeof value === 'string' && value.length >= 4) text = text.split(value).join('[redacted]');
  }
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, '[endpoint]')
    .replace(/(Bearer|Basic)\s+\S+/gi, '$1 [redacted]')
    .replace(/((?:api[_-]?key|token|password|secret|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/[\u0000-\u0008\u000b-\u001f]/g, '');
  return text.trim().slice(-4096) || 'MCP connection or tool discovery failed.';
}
