import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessDriver } from '../harness/index.mjs';
import { createConversationDriver } from '../conversation-driver.mjs';
import { openStore } from '../store.mjs';
import { Compat } from '../compat.mjs';
import { createCompatServer } from '../server.mjs';
import { workspaceIdentity } from '../workspaces.mjs';

const ext = name => `_goose/unstable/${name}`;
const allow = { outcome: { outcome: 'selected', optionId: 'allow_once' } };
const stopped = pid => assert.throws(() => process.kill(pid, 0), /ESRCH/, `MCP process ${pid} must stop`);

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-session-lifecycle-'));
  const script = path.join(root, 'mcp.mjs'), pidFile = path.join(root, 'pids.jsonl');
  await writeFile(script, String.raw`import {appendFileSync} from 'node:fs'; import {createInterface} from 'node:readline';
appendFileSync(process.argv[2],JSON.stringify({pid:process.pid})+'\n');
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!('id'in m))return;let result;
if(m.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{},resources:{}},serverInfo:{name:'lifecycle-fixture',version:'1'}};
else if(m.method==='tools/list')result={tools:[]};
else if(m.method==='resources/read')result={contents:[{uri:m.params.uri,text:'ACTUAL_RESOURCE_RECEIPT'}]};
else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Unknown'}})+'\n');return;}
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');});`);
  const slow = Promise.withResolvers();
  const model = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fixture', max_model_len: 32768 }] })); return;
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'lifecycle-fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    emit({ role: 'assistant', content: 'Actual lifecycle fixture answer' });
    if (JSON.stringify(body.messages).includes('SLOW_LIFECYCLE')) { slow.resolve(); return; }
    emit({}, 'stop'); res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const store = await openStore(path.join(root, 'data'));
  await store.update(state => {
    state.providers = [{ id: 'fixture', displayName: 'Fixture', engine: 'openai_compatible', apiUrl: `http://127.0.0.1:${model.address().port}`, models: ['fixture'], requiresAuth: false }];
    state.defaults = { providerId: 'fixture', modelId: 'fixture' };
  });
  const native = await createHarnessDriver({ dataDir: path.join(root, 'native'), cwd: root });
  const driver = createConversationDriver(native, store), compat = new Compat(store, driver);
  await compat.initialize();
  const connection = { notify() {}, async ask() { return allow; } };
  t.after(async () => { await compat.close(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); });
  const request = (method, params) => compat.request(method, params, connection);
  const create = async (mcp = true) => (await request('session/new', { cwd: root, mcpServers: mcp ? [{ name: 'probe', command: process.execPath, args: [script, pidFile], env: [] }] : [], _meta: { enabledExtensions: ['developer', ...(mcp ? ['probe'] : [])] } })).sessionId;
  const pids = async () => (await readFile(pidFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line).pid);
  const tool = (sessionId, name, args) => request(ext('tools/call'), { sessionId, name: `developer__${name}`, arguments: args });
  return { root, native, driver, store, compat, connection, request, create, pids, tool, slow };
}

test('close and delete release real MCP processes and session leases; close permits a clean reopen', { timeout: 30_000 }, async t => {
  const f = await fixture(t), id = await f.create();
  await assert.rejects(f.pids(), /ENOENT/);
  await f.request(ext('tools/list'), { sessionId: id });
  const first = (await f.pids()).at(-1); process.kill(first, 0);
  assert.deepEqual(await f.request('session/close', { sessionId: id }), {});
  stopped(first);
  assert.ok(f.store.read().sessions.some(s => s.id === id));
  await f.request(ext('tools/list'), { sessionId: id });
  const second = (await f.pids()).at(-1); assert.notEqual(second, first); process.kill(second, 0);
  await f.request('session/delete', { sessionId: id }); stopped(second);
  assert.equal(f.store.read().sessions.some(s => s.id === id), false);
  for (const method of ['session/close', 'session/delete']) {
    const cwd = path.join(f.root, method.split('/')[1]);
    const lease = await f.request(ext('workspace/lease/acquire'), { requestedPath: cwd, expectedState: 'missing', expectedIdentity: workspaceIdentity(cwd) });
    const { sessionId } = await f.request('session/new', { cwd, mcpServers: [], _meta: { workspaceMode: 'codepro', workspaceLeaseId: lease.leaseId, enabledExtensions: ['developer'] } });
    assert.equal(f.compat.workspaces.sessions.has(sessionId), true);
    await f.request(method, { sessionId });
    assert.equal(f.compat.workspaces.sessions.has(sessionId), false);
  }
});

test('a direct file write waiting for approval blocks close/delete/truncate until its actual result settles', { timeout: 30_000 }, async t => {
  const f = await fixture(t), id = await f.create();
  const entered = Promise.withResolvers(), answer = Promise.withResolvers();
  f.connection.ask = () => { entered.resolve(); return answer.promise; };
  const running = f.tool(id, 'write', { file_path: 'approved.txt', content: 'approved fixture write' });
  await entered.promise;
  assert.equal(f.driver.isConversationBusy(id), true);
  for (const method of ['session/close', 'session/delete']) await assert.rejects(f.request(method, { sessionId: id }), /active conversation operation/);
  await assert.rejects(f.request(ext('session/conversation/truncate'), { sessionId: id, truncateFrom: 0 }), /active conversation operation/);
  assert.ok(f.store.read().sessions.some(s => s.id === id));
  await assert.rejects(access(path.join(f.root, 'approved.txt')));
  answer.resolve(allow); assert.equal((await running).isError, false);
  assert.equal(await readFile(path.join(f.root, 'approved.txt'), 'utf8'), 'approved fixture write');
  const pid = (await f.pids()).at(-1); await f.request('session/delete', { sessionId: id }); stopped(pid);
});

test('a first user turn waits for native tool maintenance, then streams through Harness', { timeout: 30_000 }, async t => {
  const f = await fixture(t), id = await f.create(false);
  await f.request(ext('tools/list'), { sessionId: id });
  await writeFile(path.join(f.root, 'poll.txt'), 'isolated sidebar-equivalent read');
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const polling = f.driver.callTool(id, 'read', { file_path: 'poll.txt' }, {
    onPermission: async () => { entered.resolve(); await release.promise; return true; },
  });
  await entered.promise;
  const updates = [];
  f.connection.notify = (_method, params) => updates.push(params.update);
  const sending = f.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'FIRST_SEND_AFTER_PANEL_READ' }] });
  const outcome = sending.then(value => ({ value }), error => ({ error }));
  release.resolve();
  assert.equal((await polling).isError, false);
  const result = await outcome;
  assert.equal(result.error, undefined);
  assert.equal(result.value.stopReason, 'end_turn');
  assert.ok(updates.some(update => update?.sessionUpdate === 'agent_message_chunk' && update.content?.text.includes('Actual lifecycle fixture answer')));
});

test('background native jobs block deletion and truncation after their launch call has returned', { timeout: 30_000 }, async t => {
  const f = await fixture(t), id = await f.create();
  const result = await f.tool(id, process.platform === 'win32' ? 'pwsh' : 'bash', { description: 'Lifecycle isolated background job', command: process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30', run_in_background: true });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.structuredContent.kind, 'background');
  assert.equal(f.driver.isConversationBusy(id), false);
  for (const method of ['session/close', 'session/delete']) await assert.rejects(f.request(method, { sessionId: id }), /background jobs/);
  await assert.rejects(f.request('session/fork', { sessionId: id }), /background jobs/);
  assert.ok(f.store.read().sessions.some(s => s.id === id));
  const killed = await f.tool(id, 'job_kill', { job_id: result.structuredContent.jobId });
  assert.equal(killed.isError, false, JSON.stringify(killed));
  await f.tool(id, 'job_output', { job_id: result.structuredContent.jobId, wait: true, timeout_ms: 5000 });
  const pid = (await f.pids()).at(-1); await f.request('session/delete', { sessionId: id }); stopped(pid);
});

test('close awaits real prompt cancellation and its final persistence while rejecting a concurrent new prompt', { timeout: 30_000 }, async t => {
  const f = await fixture(t), id = await f.create();
  const originalPrompt = f.native.prompt.bind(f.native), settled = Promise.withResolvers(), finish = Promise.withResolvers();
  const visible = Promise.withResolvers();
  f.connection.notify = (_method, params) => { if (params.update?.sessionUpdate === 'agent_message_chunk') visible.resolve(); };
  f.native.prompt = async (...args) => { const result = await originalPrompt(...args); settled.resolve(result); await finish.promise; return result; };
  const pending = f.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'SLOW_LIFECYCLE' }] });
  await visible.promise;
  let closed = false;
  const closing = f.request('session/close', { sessionId: id }).then(value => { closed = true; return value; });
  assert.equal((await settled.promise).stopReason, 'cancelled');
  assert.equal(closed, false);
  await assert.rejects(f.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'RACING_NEW_PROMPT' }] }), /session change/);
  finish.resolve(); assert.equal((await pending).stopReason, 'cancelled'); await closing;
  assert.equal(f.compat.active.has(id), false); assert.equal(f.driver.isConversationBusy(id), false);
  stopped((await f.pids()).at(-1));
  const history = f.store.read().sessions.find(s => s.id === id);
  assert.match(JSON.stringify(history.updates), /Actual lifecycle fixture answer/);
  assert.doesNotMatch(JSON.stringify(history.updates), /RACING_NEW_PROMPT/);
});

test('an ordinary fork retains source MCP scope; a committed truncate retires only the replaced native scope', { timeout: 30_000 }, async t => {
  const f = await fixture(t), id = await f.create();
  await f.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'HISTORY_TO_EDIT' }] });
  const first = (await f.pids()).at(-1), oldHistory = await f.native.history(id);
  const { sessionId: copied } = await f.request('session/fork', { sessionId: id }); process.kill(first, 0);
  await f.request(ext('tools/list'), { sessionId: copied });
  const copyPid = (await f.pids()).at(-1); assert.notEqual(copyPid, first);
  const session = f.store.read().sessions.find(s => s.id === id);
  const cutoff = session.updates.find(u => u.sessionUpdate === 'user_message_chunk')._meta.goose.created;
  await f.request(ext('session/conversation/truncate'), { sessionId: id, truncateFrom: cutoff });
  stopped(first); process.kill(copyPid, 0);
  assert.deepEqual((await f.native.history(id)).events, oldHistory.events);
  await f.request(ext('tools/list'), { sessionId: id });
  const replacementPid = (await f.pids()).at(-1); assert.notEqual(replacementPid, copyPid);
  await f.request('session/delete', { sessionId: id }); stopped(replacementPid); process.kill(copyPid, 0);
  await f.request('session/delete', { sessionId: copied }); stopped(copyPid);
});

test('direct MCP resource requests also block release while they await permission outside the conversation lock', { timeout: 30_000 }, async t => {
  const f = await fixture(t), id = await f.create();
  await f.request(ext('tools/list'), { sessionId: id });
  const entered = Promise.withResolvers(), answer = Promise.withResolvers();
  const reading = f.driver.readResource(id, 'probe', 'ui://lifecycle/receipt', { onPermission: async () => { entered.resolve(); return answer.promise; } });
  await entered.promise; assert.equal(f.driver.isConversationBusy(id), false);
  await assert.rejects(f.request('session/delete', { sessionId: id }), /active session operations/);
  await assert.rejects(f.request('session/fork', { sessionId: id }), /active operations/);
  answer.resolve(true); assert.equal((await reading).contents[0].text, 'ACTUAL_RESOURCE_RECEIPT');
  const pid = (await f.pids()).at(-1); await f.request('session/delete', { sessionId: id }); stopped(pid);
});

test('a session deleted during asynchronous capability preparation never recreates an orphan MCP scope', { timeout: 30_000 }, async t => {
  const f = await fixture(t), id = await f.create();
  await f.request(ext('tools/list'), { sessionId: id });
  const before = await f.pids(), first = before.at(-1);
  const preparing = Promise.withResolvers(), proceed = Promise.withResolvers();
  const options = f.compat.sessionOptions.bind(f.compat);
  f.compat.sessionOptions = async session => { preparing.resolve(); await proceed.promise; return options(session); };
  f.compat.initialized.delete(id);
  const calling = f.tool(id, 'write', { file_path: 'orphan.txt', content: 'must not be written' });
  const rejected = assert.rejects(calling, /Session not found/);
  await preparing.promise;
  await f.request('session/delete', { sessionId: id }); stopped(first);
  proceed.resolve(); await rejected;
  assert.deepEqual(await f.pids(), before);
  for (const pid of before) stopped(pid);
  await assert.rejects(access(path.join(f.root, 'orphan.txt')));
});

test('closing and deleting imported history does not initialize the lazy Harness runtime', { timeout: 15_000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-lifecycle-history-')), secret = 'isolated-lifecycle-history-secret';
  const store = await openStore(root);
  await store.update(s => s.sessions.push({ id: 'imported', title: 'Retained history', readonlyHistory: true, cwd: root, type: 'user', updates: [], usageUpdates: [], messageCount: 0 }));
  await store.flush();
  const app = await createCompatServer({ dataDir: root, secret }), base = await app.listen();
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/acp?token=${secret}`);
  t.after(async () => { socket.close(); await app.close(); });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let seq = 0;
  async function request(method, params = { sessionId: 'imported' }) {
    const id = ++seq;
    const result = new Promise((resolve, reject) => socket.addEventListener('message', function receive({ data }) {
      const message = JSON.parse(String(data)); if (message.id !== id) return;
      socket.removeEventListener('message', receive); message.error ? reject(Error(message.error.message)) : resolve(message.result);
    }));
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); return result;
  }
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  await request('session/close'); await request('session/delete');
  await assert.rejects(access(path.join(root, 'harness')), /ENOENT/);
});
