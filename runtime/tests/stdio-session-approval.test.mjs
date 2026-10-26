import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHarnessDriver } from '../harness/index.mjs';
import { openStore } from '../store.mjs';
import { Compat } from '../compat.mjs';
import { SafetyPolicy } from '../safety-policy.mjs';

test('stdio session grants survive later turns without restarting the service and revoke on removal or configuration change', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-stdio-grant-'));
  const script = join(root, 'server.mjs'), starts = join(root, 'starts.log');
  await writeFile(script, `import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
appendFileSync(process.argv[2], 'started\\n');
createInterface({input:process.stdin}).on('line', line => {
 const msg=JSON.parse(line); if(!('id' in msg)) return;
 const result=msg.method==='initialize' ? {protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}
 : msg.method==='tools/list' ? {tools:[{name:'query',description:'Isolated query',inputSchema:{type:'object',properties:{}}}]}
 : {content:[{type:'text',text:'local fixture receipt'}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result})+'\\n');
});`);
  const driver = await createHarnessDriver({ cwd: root, dataDir: join(root, 'native') });
  t.after(() => driver.close());
  const store = await openStore(join(root, 'host'));
  const host = Object.assign(Object.create(Compat.prototype), { store, settings: { extensions: async () => [] }, active: new Map(), safety: new SafetyPolicy(store) });
  const server = { serverName: 'local', transport: 'stdio', command: process.execPath, args: [script, starts] };
  const s = { id: randomUUID(), cwd: root, mcpServers: [{ name: 'local', command: process.execPath, args: [script, starts] }] };
  const provider = { id: 'offline', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture' };
  await store.update(state => state.sessions.push(s));
  await driver.createSession({ sessionId: s.id, cwd: root, provider, model: 'fixture', options: { mcpServers: [server] } });
  const questions = [];
  let choice = 'allow_always';
  const invoke = () => driver.callTool(s.id, 'mcp__local__query', {}, {
    onToolPolicy: call => host.toolPolicy(s, call, call.signal),
    onPermission: call => host.approveTool(s, call, { async ask(_method, params) {
      questions.push(params); return { outcome: { outcome: 'selected', optionId: choice } };
    } }, call.signal),
  });
  assert.equal((await invoke()).isError, false);
  const initialStarts = await readFile(starts, 'utf8');
  for (let turn = 0; turn < 2; turn++) {
    await driver.configureSession(s.id, { systemPrompt: 'Updated context ' + turn, mcpServers: [structuredClone(server)] });
    assert.equal((await invoke()).isError, false);
  }
  assert.equal(questions.length, 1, 'Equivalent later turns must keep the explicit session grant');
  assert.equal(await readFile(starts, 'utf8'), initialStarts, 'Context updates must not restart the local service after transport negotiation');
  choice = 'reject_once';
  await driver.configureSession(s.id, { mcpServers: [{ ...server, env: { FIXTURE_REVISION: '2' } }] });
  assert.equal((await invoke()).isError, true);
  assert.equal(questions.length, 2, 'Changed environment creates a new connection and grant boundary');
  choice = 'allow_always';
  await invoke();
  await driver.configureSession(s.id, { mcpServers: [] });
  assert.equal((await driver.listTools(s.id)).some(tool => tool.name === 'mcp__local__query'), false);
  await driver.configureSession(s.id, { mcpServers: [server] });
  choice = 'reject_once';
  assert.equal((await invoke()).isError, true);
  assert.equal(questions.length, 4, 'Re-enabling must not revive an old grant');
  await driver.releaseNativeSessionCapabilities(s.id);
  assert.equal((await driver.listTools(s.id)).some(tool => tool.name === 'mcp__local__query'), false);
});
