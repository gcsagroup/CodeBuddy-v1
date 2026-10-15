import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';

// Exact reuse of the Apache-2.0 Goose template, bundled beside the runtime so
// installed desktop builds do not depend on Rust source directories.
const templateUrl = new URL('./assets/mcp-app-proxy.html', import.meta.url);
const loopback = address => address === '::1' || /^127\.\d+\.\d+\.\d+$/.test(address ?? '') || /^::ffff:127\.\d+\.\d+\.\d+$/.test(address ?? '');
const matches = (candidate, secret) => typeof candidate === 'string' && Buffer.byteLength(candidate) === Buffer.byteLength(secret) && timingSafeEqual(Buffer.from(candidate), Buffer.from(secret));

// This is CSP source syntax validation, not a semantic content classification.
function normalizeSource(input) {
  let source = input.trim();
  if (!source || /[\s;,"']/.test(source)) return null;
  let scheme = '';
  if (source.includes('://')) {
    const split = source.indexOf('://'); scheme = source.slice(0, split).toLowerCase();
    if (!['http', 'https', 'ws', 'wss'].includes(scheme)) return null;
    source = source.slice(split + 3).split(/[/?#]/, 1)[0];
  }
  if (!source || source === '*' || source.includes('@')) return null;
  let host = source, port;
  if (source.startsWith('[')) {
    const match = /^\[([^\]]+)\](?::(\d+))?$/.exec(source);
    if (!match || isIP(match[1]) !== 6) return null;
    host = match[1]; port = match[2];
  } else if (source.includes(':')) {
    const match = /^([^:]+):(\d+)$/.exec(source);
    if (!match) return null;
    host = match[1]; port = match[2];
  }
  if (port !== undefined && Number(port) > 65535) return null;
  const dns = host.startsWith('*.') ? host.slice(2) : host;
  if (dns.toLowerCase() !== 'localhost' && !isIP(dns) && !(dns.includes('.') && dns.split('.').every(label => /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label)))) return null;
  return `${scheme ? `${scheme}://` : ''}${source.toLowerCase()}`;
}
const domains = (query, name) => [...new Set((query.get(name) ?? '').split(',').map(normalizeSource).filter(Boolean))].join(' ');
function policy(query, guestOrigin) {
  const extra = name => { const value = domains(query, name); return value ? ` ${value}` : ''; };
  const resources = extra('resource_domains'), scripts = extra('script_domains');
  return `default-src 'none'; script-src 'self' 'unsafe-inline'${resources}${scripts}; script-src-elem 'self' 'unsafe-inline'${resources}${scripts}; style-src 'self' 'unsafe-inline'${resources}; style-src-elem 'self' 'unsafe-inline'${resources}; connect-src 'self'${extra('connect_domains')}; img-src 'self' data: blob:${resources}; font-src 'self'${resources}; media-src 'self' data: blob:${resources}; frame-src 'self' ${guestOrigin}${extra('frame_domains')}; object-src 'none'; base-uri 'self'${extra('base_uri_domains')}`;
}
function send(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', ...headers });
  response.end(body);
}
function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    let size = 0, ended = false; const chunks = [];
    const fail = (status, message) => { if (!ended) { ended = true; reject(Object.assign(new Error(message), { status })); } };
    if (Number(request.headers['content-length']) > limit) { fail(413, 'Guest HTML exceeds the request limit'); request.resume(); return; }
    request.on('data', chunk => { if (ended) return; size += chunk.length; if (size > limit) { chunks.length = 0; fail(413, 'Guest HTML exceeds the request limit'); } else chunks.push(chunk); });
    request.on('end', () => { if (!ended) { ended = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    request.on('aborted', () => fail(400, 'Request interrupted'));
    request.on('error', () => fail(400, 'Request interrupted'));
  });
}

/** Existing proxy document, with guest HTML on a separate read-only loopback origin. */
export async function createMcpAppProxy({ secret, ttlMs = 300_000, maxEntries = 64, maxBytes = 16 * 1024 * 1024, maxTotalBytes = 64 * 1024 * 1024, now = () => performance.now() } = {}) {
  if (typeof secret !== 'string' || secret.length < 16) throw new TypeError('A local proxy secret of at least 16 characters is required');
  if (![ttlMs, maxEntries, maxBytes, maxTotalBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new TypeError('Proxy limits must be positive integers');
  const template = await readFile(templateUrl, 'utf8');
  if (!template.includes('{{OUTER_CSP}}')) throw new Error('MCP app proxy template is missing its policy slot');
  const entries = new Map(); let total = 0, closed = false;
  const remove = nonce => { const entry = entries.get(nonce); if (entry) { total -= entry.bytes; entries.delete(nonce); } };
  const prune = () => { const cutoff = now() - ttlMs; for (const [nonce, entry] of entries) if (entry.created <= cutoff) remove(nonce); };
  const guest = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (closed) return send(response, 503, 'Proxy closed');
    if (!loopback(request.socket.remoteAddress)) return send(response, 403, 'Loopback access required');
    if (url.pathname !== '/mcp-app-guest') return send(response, 404, 'Not found');
    if (request.method !== 'GET') return send(response, 405, 'Read-only guest endpoint', { Allow: 'GET' });
    prune(); const entry = entries.get(url.searchParams.get('nonce'));
    if (!entry) return send(response, 404, 'Guest content not found');
    send(response, 200, entry.html, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': entry.csp, 'Referrer-Policy': 'strict-origin' });
  });
  await new Promise((resolve, reject) => { guest.once('error', reject); guest.listen(0, '127.0.0.1', () => { guest.removeListener('error', reject); resolve(); }); });
  const guestOrigin = `http://127.0.0.1:${guest.address().port}`;
  const reaper = setInterval(prune, Math.min(ttlMs, 30_000)); reaper.unref();
  return {
    guestOrigin,
    handles(request) { return ['/mcp-app-proxy', '/mcp-app-guest'].includes(new URL(request.url, 'http://127.0.0.1').pathname); },
    async handle(request, response) {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (!this.handles(request)) return false;
      if (closed) { send(response, 503, 'Proxy closed'); return true; }
      if (!loopback(request.socket.remoteAddress)) { send(response, 403, 'Loopback access required'); return true; }
      if (url.pathname === '/mcp-app-proxy') {
        if (request.method !== 'GET') { send(response, 405, 'Method not allowed', { Allow: 'GET' }); return true; }
        if (!matches(url.searchParams.get('secret'), secret)) { send(response, 401, 'Authentication required'); return true; }
        const csp = policy(url.searchParams, guestOrigin);
        send(response, 200, template.replace('{{OUTER_CSP}}', csp), { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp });
        return true;
      }
      if (request.method !== 'POST') { send(response, 405, 'Method not allowed', { Allow: 'POST' }); return true; }
      if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) { send(response, 415, 'Expected application/json'); return true; }
      try {
        let body;
        try { body = JSON.parse(await readBody(request, maxBytes)); } catch (error) { if (error.status) throw error; throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
        if (!matches(body?.secret, secret)) { send(response, 401, 'Authentication required'); return true; }
        if (typeof body.html !== 'string' || (body.csp !== undefined && typeof body.csp !== 'string')) throw Object.assign(new Error('Expected HTML text and optional CSP text'), { status: 400 });
        const csp = body.csp || policy(new URLSearchParams(), guestOrigin);
        if (csp.length > 32768 || /[^\x20-\x7e\t]/.test(csp)) throw Object.assign(new Error('Invalid CSP header'), { status: 400 });
        const bytes = Buffer.byteLength(body.html) + Buffer.byteLength(csp);
        if (bytes > maxBytes || bytes > maxTotalBytes) throw Object.assign(new Error('Guest HTML exceeds the storage limit'), { status: 413 });
        prune();
        while (entries.size >= maxEntries || total + bytes > maxTotalBytes) remove(entries.keys().next().value);
        const nonce = randomUUID(); entries.set(nonce, { html: body.html, csp, created: now(), bytes }); total += bytes;
        send(response, 200, JSON.stringify({ nonce, guestUrl: `${guestOrigin}/mcp-app-guest?nonce=${nonce}` }), { 'Content-Type': 'application/json' });
      } catch (error) { send(response, error.status ?? 500, error.status ? error.message : 'Guest storage failed'); }
      return true;
    },
    async close() {
      if (closed) return;
      closed = true; clearInterval(reaper); entries.clear(); total = 0;
      guest.closeAllConnections(); await new Promise((resolve, reject) => guest.close(error => error ? reject(error) : resolve()));
    },
  };
}
