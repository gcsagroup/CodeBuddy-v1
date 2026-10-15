import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createMcpAppProxy } from '../mcp-app-proxy.mjs';

const secret = 'fixture-only-mcp-proxy-auth-secret';
async function fixture(t, options = {}) {
  const proxy = await createMcpAppProxy({ secret, ...options });
  const main = createServer(async (req, res) => {
    try { if (proxy.handles(req)) { await proxy.handle(req, res); return; } res.writeHead(404); res.end(); }
    catch { res.writeHead(500); res.end('fixture error'); }
  });
  await new Promise(resolve => main.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${main.address().port}`;
  t.after(async () => { await proxy.close(); main.closeAllConnections(); await new Promise(resolve => main.close(resolve)); });
  const post = body => fetch(`${origin}/mcp-app-guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret, ...body }) });
  return { proxy, origin, post };
}

test('authenticated original proxy document preserves the sandbox protocol and serves guest HTML on a distinct read-only origin', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.origin}/mcp-app-proxy`)).status, 401);
  assert.equal((await fetch(`${f.origin}/mcp-app-proxy?secret=wrong`, { headers: { 'x-secret-key': secret } })).status, 401);
  const response = await fetch(`${f.origin}/mcp-app-proxy?secret=${secret}&color_scheme=dark`);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const csp = response.headers.get('content-security-policy'), html = await response.text();
  const template = await readFile(new URL('../../crates/goose/src/acp/templates/mcp_app_proxy.html', import.meta.url), 'utf8');
  assert.equal(html, template.replace('{{OUTER_CSP}}', csp));
  assert.ok(!html.includes(secret)); assert.match(csp, /default-src 'none'/);
  const cspOverride = "default-src 'none'; script-src 'unsafe-inline'; img-src https://images.example.com";
  const storedResponse = await f.post({ html: '<h1>APP_FIXTURE</h1>', csp: cspOverride });
  assert.equal(storedResponse.status, 200);
  const stored = await storedResponse.json();
  assert.notEqual(new URL(stored.guestUrl).origin, f.origin);
  assert.equal(new URL(stored.guestUrl).origin, f.proxy.guestOrigin);
  assert.equal(new URL(stored.guestUrl).searchParams.get('secret'), null);
  const guest = await fetch(stored.guestUrl);
  assert.equal(await guest.text(), '<h1>APP_FIXTURE</h1>'); assert.equal(guest.headers.get('content-security-policy'), cspOverride);
  assert.equal(guest.headers.get('access-control-allow-origin'), null);
  assert.equal((await fetch(`${f.origin}/mcp-app-guest?nonce=${stored.nonce}`)).status, 405);
  assert.equal((await fetch(stored.guestUrl, { method: 'POST', body: 'overwrite' })).status, 405);
  assert.equal((await fetch(`${f.proxy.guestOrigin}/status`)).status, 404);
  assert.equal((await fetch(`${f.proxy.guestOrigin}/mcp-app-proxy?secret=${secret}`)).status, 404);
  assert.equal((await fetch(`${f.proxy.guestOrigin}/mcp-app-guest?nonce=unknown`)).status, 404);
});

test('CSP origins follow old supported domains and reject policy or HTML injection', async t => {
  const f = await fixture(t);
  const url = new URL('/mcp-app-proxy', f.origin); url.searchParams.set('secret', secret);
  url.searchParams.set('connect_domains', 'https://api.example.com/path,wss://ws.example.com:443/path,http://[::1]:3000,https://bad.example.com;script-src *');
  url.searchParams.set('resource_domains', 'https://*.cloudflare.com,cdn.example.com,localhost:3000,*,data:,https://user@example.com,javascript:alert(1),https://evil.example.com\"><script>');
  const response = await fetch(url), csp = response.headers.get('content-security-policy');
  assert.equal(response.status, 200); assert.match(csp, /https:\/\/api\.example\.com wss:\/\/ws\.example\.com:443 http:\/\/\[::1\]:3000/);
  assert.match(csp, /https:\/\/\*\.cloudflare\.com cdn\.example\.com localhost:3000/);
  assert.doesNotMatch(csp, /bad\.example|evil\.example|javascript|user@/);
  assert.equal((await f.post({ html: 'a', csp: "default-src 'none'\r\nX-Leak: value" })).status, 400);
  assert.equal((await f.post({ html: 'a', csp: 123 })).status, 400);
  assert.equal((await f.post({ html: { markup: 'a' } })).status, 400);
  const fallback = await (await f.post({ html: 'default policy' })).json();
  assert.match((await fetch(fallback.guestUrl)).headers.get('content-security-policy'), /default-src 'none'/);
});

test('body authentication, actual streamed byte limits, JSON errors, and loopback boundary precede storage', async t => {
  const f = await fixture(t, { maxBytes: 2048 });
  assert.equal((await f.post({ secret: 'wrong', html: 'secret fixture' })).status, 401);
  assert.equal((await fetch(`${f.origin}/mcp-app-guest`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(`${f.origin}/mcp-app-guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await f.post({ html: 'x'.repeat(3000) })).status, 413);
  const streamedStatus = await new Promise((resolve, reject) => {
    const req = request(`${f.origin}/mcp-app-guest`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write('{"html":"'); req.write('x'.repeat(3000)); req.end('"}');
  });
  assert.equal(streamedStatus, 413);
  const captured = {};
  await f.proxy.handle({ url: `/mcp-app-proxy?secret=${secret}`, method: 'GET', socket: { remoteAddress: '192.0.2.11' } }, { writeHead: status => { captured.status = status; }, end: body => { captured.body = body; } });
  assert.equal(captured.status, 403);
});

test('nonces expire, oldest entries are evicted by count and total bytes, and close releases the guest listener', async t => {
  let time = 0;
  const f = await fixture(t, { ttlMs: 100, maxEntries: 2, maxBytes: 4096, maxTotalBytes: 600, now: () => time });
  const put = async marker => (await f.post({ html: marker.repeat(256), csp: "default-src 'none'" })).json();
  const a = await put('a'); time = 10; const b = await put('b'); time = 20; const c = await put('c');
  assert.equal((await fetch(a.guestUrl)).status, 404); assert.equal((await fetch(b.guestUrl)).status, 200); assert.equal((await fetch(c.guestUrl)).status, 200);
  time = 115;
  assert.equal((await fetch(b.guestUrl)).status, 404); assert.equal((await fetch(c.guestUrl)).status, 200);
  const large = await (await f.post({ html: 'd'.repeat(500), csp: "default-src 'none'" })).json();
  assert.equal((await fetch(c.guestUrl)).status, 404); assert.equal((await fetch(large.guestUrl)).status, 200);
  await f.proxy.close();
  await assert.rejects(fetch(large.guestUrl), /fetch failed/);
  assert.equal((await fetch(`${f.origin}/mcp-app-proxy?secret=${secret}`)).status, 503);
  await f.proxy.close();
});
