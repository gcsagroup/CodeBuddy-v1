import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarnessDriver } from '../index.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-background-'));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [], requests = [], wire = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    if (!raw) { res.writeHead(405).end(); return; }
    const body = JSON.parse(raw);
    if (req.url.includes('/mcp')) {
      wire.push(body.method);
      if (!('id' in body)) { res.writeHead(202).end(); return; }
      if (body.method === 'initialize') await gate;
      if (body.method === 'tools/call') calls.push(body.params);
      const result = body.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'slow', version: '1' } }
        : body.method === 'tools/list' ? { tools: [{ name: 'probe', description: 'Controlled probe', inputSchema: { type: 'object', properties: {} } }] }
          : { content: [{ type: 'text', text: 'PROBE_OK' }] };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    } else {
      requests.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [delta, finish_reason] of [[{ content: 'FAST_REPLY' }, null], [{}, 'stop']])
        res.write(`data: ${JSON.stringify({ id: 'fast', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const driver = await createHarnessDriver({ dataDir: path.join(root, 'data'), cwd: root });
  t.after(async () => { release(); await driver.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const mcp = { serverName: 'slow', transport: 'streamable-http', url: `http://127.0.0.1:${server.address().port}/mcp` };
  const create = (options = {}) => driver.createSession({ cwd: root, provider: { id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 65536 }, model: 'fixture', options: { backgroundMcp: true, mcpServers: [mcp], ...options } });
  return { root, driver, mcp, create, release, calls, requests, wire };
}

test('first reply bypasses a gated MCP; targeted discovery waits, cancellation and permissions remain authoritative', { timeout: 20000 }, async t => {
  const f = await fixture(t), { sessionId: id } = await f.create();
  assert.equal(f.driver.extensionStatus(id)[0].status, 'connecting');
  await f.driver.prompt(id, 'Reply without external tools');
  assert.equal(f.requests.length, 1, 'model is dispatched before MCP initialize is released');
  assert.equal(f.driver.extensionStatus(id)[0].status, 'connecting');
  const catalog = await f.driver.callTool(id, 'search_mcp_tools', {}, { onPermission: async () => true });
  assert.ok(JSON.stringify(catalog).includes('slow'));
  const abort = new AbortController();
  const waiting = f.driver.callTool(id, 'search_mcp_tools', { servers: ['slow'] }, { signal: abort.signal, onPermission: async () => true });
  setTimeout(() => abort.abort(), 50);
  await waiting.catch(() => {});
  assert.equal(f.calls.length, 0);
  let settled = false;
  const selected = f.driver.callTool(id, 'search_mcp_tools', { names: ['mcp__slow__probe'] }, { onPermission: async () => true }).then(value => { settled = true; return value; });
  await delay(50); assert.equal(settled, false);
  f.release();
  assert.ok(JSON.stringify(await selected).includes('mcp__slow__probe'));
  assert.equal(f.driver.extensionStatus(id)[0].status, 'ready');
  await f.driver.callTool(id, 'mcp__slow__probe', {}, { onToolPolicy: () => ({ kind: 'ask' }), onPermission: async () => false }).catch(() => {});
  assert.equal(f.calls.length, 0, 'discovery never grants execution');
  await f.driver.callTool(id, 'mcp__slow__probe', {}, { onToolPolicy: () => ({ kind: 'ask' }), onPermission: async () => true });
  assert.equal(f.calls.length, 1);
});

test('removed pending remote cannot reappear; other selected session retains its lease', { timeout: 20000 }, async t => {
  const f = await fixture(t), a = await f.create(), b = await f.create();
  await f.driver.configureSession(a.sessionId, { backgroundMcp: true, mcpServers: [] });
  f.release();
  await f.driver.callTool(b.sessionId, 'search_mcp_tools', { servers: ['slow'] }, { onPermission: async () => true });
  assert.equal((await f.driver.listTools(a.sessionId)).some(tool => tool.name === 'mcp__slow__probe'), false);
  assert.equal((await f.driver.listTools(b.sessionId)).some(tool => tool.name === 'mcp__slow__probe'), true);
  assert.deepEqual(f.driver.extensionStatus(a.sessionId), []);
  assert.equal(f.wire.filter(method => method === 'initialize').length, 1);
});

test('late tool catalogs preserve each session allow and deny boundaries across multiple live scopes', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const allowed = await f.create({ toolFilter: { allow: ['read'] } });
  const denied = await f.create({ mcpServers: [{ ...f.mcp, selectedTools: [] }], toolFilter: { allow: ['read'], deny: ['write'] } });
  const isolated = await f.create({ mcpServers: [], toolFilter: { allow: ['read'] } });
  f.release();
  await f.driver.callTool(allowed.sessionId, 'search_mcp_tools', { servers: ['slow'] }, { onPermission: async () => true });
  assert.ok((await f.driver.listTools(allowed.sessionId)).some(tool => tool.name === 'mcp__slow__probe'));
  assert.equal((await f.driver.listTools(denied.sessionId)).some(tool => tool.name === 'mcp__slow__probe'), false);
  assert.equal((await f.driver.listTools(denied.sessionId)).some(tool => tool.name === 'write'), false);
  assert.equal((await f.driver.listTools(isolated.sessionId)).some(tool => tool.name === 'mcp__slow__probe'), false);
  await f.driver.callTool(allowed.sessionId, 'mcp__slow__probe', {}, { onPermission: async () => true });
  const rejected = await f.driver.callTool(denied.sessionId, 'mcp__slow__probe', {}, { onPermission: async () => true });
  assert.equal(rejected.isError, true);
  assert.equal(f.calls.length, 1);
});

test('pending stdio survives same-config refresh but removal closes it without publishing late tools', { timeout: 20000 }, async t => {
  const f = await fixture(t), marker = path.join(f.root, 'started'), release = path.join(f.root, 'release');
  const script = path.join(f.root, 'stdio.mjs');
  await writeFile(script, `import {createInterface} from 'node:readline'; import {writeFile,access} from 'node:fs/promises'; import {setTimeout as delay} from 'node:timers/promises';
for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);if(!('id' in m))continue;if(m.method==='initialize'){await writeFile(process.argv[2],'started');while(!await access(process.argv[3]).then(()=>true,()=>false))await delay(10);}console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'local',version:'1'}}:{tools:[]}}));}`);
  const options = { backgroundMcp: true, mcpServers: [{ serverName: 'local', transport: 'stdio', command: process.execPath, args: [script, marker, release] }] };
  const { sessionId: id } = await f.create(options);
  for (let i = 0; !await access(marker).then(() => true, () => false) && i < 300; i++) await delay(10);
  await access(marker);
  await f.driver.configureSession(id, options);
  assert.equal(f.driver.extensionStatus(id)[0].status, 'connecting');
  await f.driver.configureSession(id, { backgroundMcp: true, mcpServers: [] });
  await writeFile(release, 'go');
  assert.deepEqual(f.driver.extensionStatus(id), []);
  assert.equal((await f.driver.listTools(id)).some(tool => tool.name.startsWith('mcp__local__')), false);
  await f.driver.configureSession(id, options);
  await f.driver.callTool(id, 'search_mcp_tools', { servers: ['local'] }, { onPermission: async () => true });
  assert.equal(f.driver.extensionStatus(id)[0].status, 'ready', 'intentional removal must not impose startup-failure cooldown on re-add');
});

test('late remote definitions still obey the session tool filter', { timeout: 20000 }, async t => {
  const f = await fixture(t), { sessionId: id } = await f.create({ mainAgentRole: { baseline: () => ({ id: 'restricted', revision: 1, name: 'Restricted', prompt: '', capabilities: 'selected', tools: [], skills: [], mcpServers: [] }), input: () => null } });
  f.release();
  for (let i = 0; f.driver.extensionStatus(id)[0].status === 'connecting' && i < 300; i++) await delay(10);
  assert.equal(f.driver.extensionStatus(id)[0].status, 'ready');
  assert.equal((await f.driver.listTools(id)).some(tool => tool.name === 'mcp__slow__probe'), false);
});


test('failed background subprocess reports its diagnostic without repeated automatic launches', { timeout: 15000 }, async t => {
  const f = await fixture(t), script = path.join(f.root, 'fail.mjs');
  const launches = path.join(f.root, 'launches');
  await writeFile(script, `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(launches)},'launch\\n');console.error('fixture initialization failure');process.exit(1);`);
  const { sessionId: id } = await f.create({ mcpServers: [{ serverName: 'broken', transport: 'stdio', command: process.execPath, args: [script] }] });
  for (let i = 0; f.driver.extensionStatus(id)[0].status === 'connecting' && i < 300; i++) await delay(10);
  const status = f.driver.extensionStatus(id)[0];
  assert.equal(status.status, 'error');
  assert.match(status.error, /fixture initialization failure/);
  const initialLaunches = await readFile(launches, 'utf8');
  assert.ok(initialLaunches.includes('launch'));
  // SDK auto negotiation may restart a transport before declaring startup
  // failed. Once failure is published, our bridge must not start it again.
  await delay(700);
  assert.equal(await readFile(launches, 'utf8'), initialLaunches);
  assert.deepEqual(f.driver.extensionStatus(id)[0], status);
  await f.driver.prompt(id, 'Continue despite the failed optional connection');
  assert.equal(f.requests.length, 1);
});
