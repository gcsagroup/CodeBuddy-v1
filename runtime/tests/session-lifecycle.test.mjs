import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, access, realpath, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessDriver } from '../harness/index.mjs';
import { createConversationDriver } from '../conversation-driver.mjs';
import { openStore } from '../store.mjs';
import { Compat } from '../compat.mjs';
import { createCompatServer } from '../server.mjs';
import { workspaceIdentity } from '../workspaces.mjs';
import { DesktopCoordinator } from '../desktop-coordinator.mjs';

const ext = name => `_goose/unstable/${name}`;
const allow = { outcome: { outcome: 'selected', optionId: 'allow_once' } };
const stopped = pid => assert.throws(() => process.kill(pid, 0), /ESRCH/, `MCP process ${pid} must stop`);

async function fixture(t, storageOptions) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'codebuddy-session-lifecycle-')));
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
  const store = await openStore(path.join(root, 'data'), storageOptions);
  await store.update(state => {
    state.providers = [{ id: 'fixture', displayName: 'Fixture', engine: 'openai_compatible', apiUrl: `http://127.0.0.1:${model.address().port}`, models: ['fixture'], requiresAuth: false }];
    state.defaults = { providerId: 'fixture', modelId: 'fixture' };
    state.toolPermissions = { developer__write: 'ask_before' };
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

test('real Harness continues the same chat after a failed terminal snapshot without rerunning the completed turn', { timeout: 35_000 }, async t => {
  const locked = Object.assign(new Error('fixture terminal file is locked'), { code: 'EPERM' });
  let deny = false;
  const f = await fixture(t, { replaceFile: (from, to) => deny ? Promise.reject(locked) : rename(from, to) });
  const id = await codeproSession(f);
  const prompt = f.native.prompt.bind(f.native);
  let nativeCalls = 0;
  f.native.prompt = async (...args) => {
    nativeCalls++;
    const result = await prompt(...args);
    if (nativeCalls === 1) deny = true;
    return result;
  };
  await assert.rejects(f.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'first native request' }] }), error => error === locked);
  assert.equal(f.compat.active.has(id), false);
  deny = false;
  const result = await f.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'second native request' }] });
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(nativeCalls, 2);
  const saved = f.store.readSession(id);
  for (const text of ['first native request', 'second native request'])
    assert.equal(saved.updates.filter(update => update.sessionUpdate === 'user_message_chunk' && update.content.text === text).length, 1);
  assert.equal(saved.messageCount, 4);
  assert.equal(f.compat.runs.latest(id).state, 'completed');
  assert.equal(f.driver.isConversationBusy(id), false);
});

for (const cancelled of [false, true]) test(`desktop resume during native completion waits for Compat settlement (cancelled=${cancelled})`, { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const cwd = path.join(f.root, 'resume-project');
  const lease = await f.request(ext('workspace/lease/acquire'), { requestedPath: cwd, expectedState: 'missing', expectedIdentity: workspaceIdentity(cwd) });
  const { sessionId: id } = await f.request('session/new', { cwd, mcpServers: [],
    _meta: { workspaceMode: 'codepro', workspaceLeaseId: lease.leaseId, enabledExtensions: ['developer'] } });
  f.compat.desktop = new DesktopCoordinator({ directory: path.join(f.root, 'desktop') });
  const entered = Promise.withResolvers(), settle = Promise.withResolvers();
  const originalFinish = f.compat.runs.finishHarnessAttempt.bind(f.compat.runs);
  f.compat.runs.finishHarnessAttempt = async (...args) => {
    entered.resolve();
    await settle.promise;
    return originalFinish(...args);
  };
  t.after(() => settle.resolve());
  const running = f.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'Complete independent work' }] });
  await entered.promise;
  const turn = f.compat.desktop.begin({ sessionId: id, token: 'paused-turn' });
  await turn.execute({ name: 'mcp__qwen_computer__get_app_state' }, async () => ({}));
  f.compat.desktop.pause(id, 'paused-turn');
  await turn.end();
  const revision = f.compat.desktop.state().revision;
  await assert.rejects(f.request(ext('desktop/control'), { action: 'resume', revision, expectedSessionId: 'different-chat' }), /所属对话已变化/);
  assert.equal(f.compat.desktop.state().paused, true, 'a stale cross-chat button cannot resume a different owner');

  await assert.rejects(f.driver.steer(id, 'late input'), { harnessCode: 'PROMPT_IDLE' });
  let resumed = false;
  const resume = f.request(ext('desktop/control'), { action: 'resume', revision }).then(result => { resumed = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resumed, false, 'do not hand an unfinished session back to the composer');
  if (cancelled) await f.request('session/cancel', { sessionId: id });
  settle.resolve();
  await running;
  const state = await resume;
  assert.equal(state.paused, false);
  assert.equal(state.owner, null);
  assert.equal(state.continueSessionId, cancelled ? null : id);
  if (!cancelled) {
    const result = await f.request('session/prompt', { sessionId: state.continueSessionId,
      prompt: [{ type: 'text', text: 'Continue original work after a fresh observation' }] });
    assert.equal(result.stopReason, 'end_turn');
  }
});

test('deep recovery: ordinary running conversations receive resume input through Harness', { timeout: 30_000 }, async t => {
  const f = await fixture(t), id = await f.create(false);
  f.compat.desktop = new DesktopCoordinator({ directory: path.join(f.root, 'desktop') });
  const running = f.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'SLOW_LIFECYCLE' }] });
  await f.slow.promise;
  const turn = f.compat.desktop.begin({ sessionId: id, token: 'ordinary-turn' });
  await turn.execute({ name: 'mcp__qwen_computer__get_app_state' }, async () => ({}));
  f.compat.desktop.pause(id, 'ordinary-turn');
  await turn.end();

  const admitted = [];
  const original = f.native.steer.bind(f.native);
  f.native.steer = async (...args) => { const result = await original(...args); admitted.push(args[0]); return result; };
  try {
    const state = await f.request(ext('desktop/control'), { action: 'resume', revision: f.compat.desktop.state().revision });
    assert.equal(state.paused, false);
    assert.deepEqual(admitted, [id], 'normal chat must not silently drop its resume input');
  } finally {
    await f.request('session/cancel', { sessionId: id });
    await running;
  }
});

test('deep recovery: cancelling during persistence cannot resurrect the completed desktop turn', { timeout: 30_000 }, async t => {
  const f = await fixture(t), cwd = path.join(f.root, 'cancel-project');
  const lease = await f.request(ext('workspace/lease/acquire'), { requestedPath: cwd, expectedState: 'missing', expectedIdentity: workspaceIdentity(cwd) });
  const { sessionId: id } = await f.request('session/new', { cwd, mcpServers: [],
    _meta: { workspaceMode: 'codepro', workspaceLeaseId: lease.leaseId, enabledExtensions: ['developer'] } });
  const desktop = f.compat.desktop = new DesktopCoordinator({ directory: path.join(f.root, 'desktop') });
  const begin = desktop.begin.bind(desktop);
  desktop.begin = options => {
    const turn = begin(options);
    return { ...turn, end: async () => {
      await turn.execute({ name: 'mcp__qwen_computer__get_app_state' }, async () => ({}));
      desktop.pause(id, options.token);
      await turn.end();
    } };
  };
  const entered = Promise.withResolvers(), settle = Promise.withResolvers();
  const finish = f.compat.runs.finishHarnessAttempt.bind(f.compat.runs);
  f.compat.runs.finishHarnessAttempt = async (...args) => { entered.resolve(); await settle.promise; return finish(...args); };
  t.after(() => settle.resolve());
  const running = f.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'Complete work' }] });
  await entered.promise;
  assert.equal(desktop.state().owner.sessionId, id);
  await f.request('session/cancel', { sessionId: id });
  settle.resolve();
  assert.equal((await running).stopReason, 'cancelled');
  assert.equal(desktop.state().paused, false);
  assert.equal(desktop.state().owner, null);
});

test('a new user prompt continues its ended desktop pause without a separate unlock', { timeout: 30_000 }, async t => {
  const f = await fixture(t), id = await f.create(false);
  f.compat.desktop = new DesktopCoordinator({ directory: path.join(f.root, 'desktop') });
  const turn = f.compat.desktop.begin({ sessionId: id, token: 'previous' });
  await turn.execute({ name: 'mcp__qwen_computer__get_app_state' }, async () => ({}));
  f.compat.desktop.pause(id, 'previous', 'escape');
  await turn.end();
  const result = await f.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'Continue' }] });
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(f.compat.desktop.state().paused, false);
});

test('close and delete release real MCP processes and session leases; close permits a clean reopen', { timeout: 30_000 }, async t => {
  const f = await fixture(t), id = await f.create();
  await assert.rejects(f.pids(), /ENOENT/);
  await f.request(ext('tools/list'), { sessionId: id, extensionName: 'probe' });
  const first = (await f.pids()).at(-1); process.kill(first, 0);
  assert.deepEqual(await f.request('session/close', { sessionId: id }), {});
  stopped(first);
  assert.ok(f.store.read().sessions.some(s => s.id === id));
  await f.request(ext('tools/list'), { sessionId: id, extensionName: 'probe' });
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

test('workspace choice metadata survives persistence and listing without changing execution binding', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  for (const origin of ['default', 'selected']) {
    const { sessionId } = await f.request('session/new', { cwd: f.root, mcpServers: [], _meta: { workspaceOrigin: origin } });
    const info = await f.request(ext('session/info'), { sessionId });
    assert.equal(info.session._meta.workspaceOrigin, origin);
    assert.equal(info.session._meta.workspaceBinding, 'writable_project');
    assert.equal(info.session.cwd, f.root);
    const listed = await f.request('session/list', { _meta: { types: ['user'] } });
    assert.equal(listed.sessions.find(s => s.sessionId === sessionId)._meta.workspaceOrigin, origin);
    const reopened = await openStore(path.join(f.root, 'data'));
    assert.equal(reopened.read().sessions.find(s => s.id === sessionId).workspaceOrigin, origin);
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
  await f.request(ext('tools/list'), { sessionId: id, extensionName: 'probe' });
  await writeFile(path.join(f.root, 'poll.txt'), 'isolated sidebar-equivalent read');
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const polling = f.driver.callTool(id, 'read', { file_path: 'poll.txt' }, {
    onToolStart: async () => { entered.resolve(); await release.promise; },
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

async function codeproSession(f) {
  const cwd = path.join(f.root, 'project');
  const lease = await f.request(ext('workspace/lease/acquire'), { requestedPath: cwd, expectedState: 'missing', expectedIdentity: workspaceIdentity(cwd) });
  return (await f.request('session/new', { cwd, mcpServers: [], _meta: { workspaceMode: 'codepro', workspaceLeaseId: lease.leaseId, enabledExtensions: ['developer'] } })).sessionId;
}

for (const failFinalization of [false, true]) test(`prompt release follows real cancellation and delayed finalization${failFinalization ? ' failure' : ''} for loaded observers`, { timeout: 30_000 }, async t => {
  const f = await fixture(t), id = await codeproSession(f);
  const finalizing = Promise.withResolvers(), releaseFinalization = Promise.withResolvers(), terminal = Promise.withResolvers();
  const finalizationError = new Error('Controlled finalization cleanup failure');
  const originalBegin = f.compat.journal.begin.bind(f.compat.journal);
  f.compat.journal.begin = async (...args) => {
    const writer = await originalBegin(...args);
    return { ...writer, async finalize() {
      finalizing.resolve();
      await releaseFinalization.promise;
      const value = await writer.finalize();
      if (failFinalization) throw finalizationError;
      return value;
    } };
  };
  const notices = [], observerNotices = [], releaseFacts = [];
  const record = (list, method, params) => {
    list.push({ method, params });
    if (params.update?.status?.data?.terminal_message_id) terminal.resolve();
    if (params.update?._meta?.goose?.activeRunId === null) releaseFacts.push(f.compat.active.has(id));
  };
  f.connection.notify = (method, params) => record(notices, method, params);
  const pending = f.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'SLOW_LIFECYCLE' }] });
  const outcome = pending.then(value => ({ value }), error => ({ error }));
  await f.slow.promise;
  const done = f.compat.active.get(id).done;
  const observer = { notify: (method, params) => record(observerNotices, method, params) };
  await f.compat.request('session/load', { sessionId: id }, observer);
  f.compat.connections.add({ sessionIds: new Set([id]), notify(_method, params) {
    if (params.update?._meta?.goose?.activeRunId === null) throw new Error('Detached observer');
  } });
  try {
    const controlToken = f.compat.active.get(id).desktopControlToken;
    assert.equal(typeof controlToken, 'string');
    await f.request('session/cancel', { sessionId: id,
      _meta: { 'codebuddy/desktop-control-token': 'expired-turn' } });
    assert.equal(f.compat.active.get(id).controller.signal.aborted, false,
      'An old overlay must not cancel the replacement prompt');
    await f.request('session/cancel', { sessionId: id,
      _meta: { 'codebuddy/desktop-control-token': controlToken } });
    assert.equal(f.compat.active.get(id).controller.signal.aborted, false,
      'Desktop Escape must never cancel the conversation, including old overlay clients');
    await f.request('session/cancel', { sessionId: id });
    await terminal.promise;
    await finalizing.promise;
    assert.equal(f.compat.active.has(id), true, 'Native terminal is not host occupancy release');
    assert.deepEqual(releaseFacts, []);
    await assert.rejects(f.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'RACING_RELEASE' }] }), /already running/);
  } finally { releaseFinalization.resolve(); }
  const result = await outcome;
  await done;
  if (failFinalization) assert.equal(result.error, finalizationError, 'A release notification failure must not mask the original error');
  else assert.equal(result.value.stopReason, 'cancelled');
  assert.equal(f.compat.active.has(id), false);
  assert.equal(f.driver.isConversationBusy(id), false);
  assert.deepEqual(releaseFacts, [false, false], 'Both live observers see release only after deletion');
  for (const list of [notices, observerNotices]) {
    const terminals = list.filter(notice => notice.params.update?.status?.data?.terminal_message_id);
    assert.equal(terminals.length, 1, 'The original and loaded observer receive the same authoritative terminal once');
    const releaseIndex = list.findIndex(notice => notice.params.update?._meta?.goose?.activeRunId === null);
    assert.ok(releaseIndex > list.indexOf(terminals[0]));
  }
});

test('early cancellation reserves admission before workspace validation and never starts native execution', { timeout: 30_000 }, async t => {
  const f = await fixture(t), id = await codeproSession(f);
  const validating = Promise.withResolvers(), releaseValidation = Promise.withResolvers();
  const validate = f.compat.workspaces.validateSession.bind(f.compat.workspaces);
  f.compat.workspaces.validateSession = async (...args) => {
    const value = await validate(...args);
    validating.resolve();
    await releaseValidation.promise;
    return value;
  };
  let creations = 0, cancellations = 0;
  const create = f.native.createSession.bind(f.native), cancel = f.native.cancel.bind(f.native);
  f.native.createSession = (...args) => { creations++; return create(...args); };
  f.native.cancel = (...args) => { cancellations++; return cancel(...args); };
  const notices = [];
  f.connection.notify = (_method, params) => notices.push(params.update);
  const pending = f.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'CANCEL_BEFORE_WORKSPACE_VALIDATION' }] });
  await validating.promise;
  const active = f.compat.active.get(id);
  assert.ok(active, 'The first await must already have an admission owner');
  try {
    await f.request('session/cancel', { sessionId: id });
    assert.equal(active.controller.signal.aborted, true);
    assert.equal(cancellations, 0, 'There is no native turn to cancel before session setup');
  } finally { releaseValidation.resolve(); }
  assert.equal((await pending).stopReason, 'cancelled');
  await active.done;
  assert.equal(creations, 0);
  assert.equal(f.compat.active.has(id), false);
  assert.equal(f.store.readSession(id).updates.length, 0, 'Unadmitted text is not projected into history');
  assert.equal(notices.some(update => update?.status?.data?.terminal_message_id), false, 'No native terminal is invented');
  assert.equal(notices.filter(update => update?._meta?.goose?.activeRunId === null).length, 1);
  const validationError = new Error('Controlled unavailable workspace');
  f.compat.workspaces.validateSession = async () => { throw validationError; };
  await assert.rejects(f.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'INVALID_WORKSPACE_ADMISSION' }] }), error => error === validationError);
  assert.equal(f.compat.active.has(id), false, 'Validation failure also releases the reserved admission');
  assert.equal(creations, 0);
  assert.equal(f.store.readSession(id).updates.length, 0);
  f.compat.workspaces.validateSession = validate;
  assert.equal((await f.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'AFTER_EARLY_CANCEL' }] })).stopReason, 'end_turn');
  assert.equal(creations, 1);
});

// Fork and truncate each reopen encrypted MCP configuration on macOS.
test('an ordinary fork retains source MCP scope; a committed truncate retires only the replaced native scope', { timeout: process.platform === 'darwin' ? 90_000 : 30_000 }, async t => {
  const f = await fixture(t), id = await f.create();
  await f.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'HISTORY_TO_EDIT' }] });
  await f.request(ext('tools/list'), { sessionId: id, extensionName: 'probe' });
  const first = (await f.pids()).at(-1), oldHistory = await f.native.history(id);
  const { sessionId: copied } = await f.request('session/fork', { sessionId: id }); process.kill(first, 0);
  await f.request(ext('tools/list'), { sessionId: copied, extensionName: 'probe' });
  const copyPid = (await f.pids()).at(-1); assert.notEqual(copyPid, first);
  const session = f.store.read().sessions.find(s => s.id === id);
  const cutoff = session.updates.find(u => u.sessionUpdate === 'user_message_chunk')._meta.goose.created;
  await f.request(ext('session/conversation/truncate'), { sessionId: id, truncateFrom: cutoff });
  stopped(first); process.kill(copyPid, 0);
  assert.deepEqual((await f.native.history(id)).events, oldHistory.events);
  await f.request(ext('tools/list'), { sessionId: id, extensionName: 'probe' });
  const replacementPid = (await f.pids()).at(-1); assert.notEqual(replacementPid, copyPid);
  await f.request('session/delete', { sessionId: id }); stopped(replacementPid); process.kill(copyPid, 0);
  await f.request('session/delete', { sessionId: copied }); stopped(copyPid);
});

test('direct MCP resource requests also block release while they await permission outside the conversation lock', { timeout: 30_000 }, async t => {
  const f = await fixture(t), id = await f.create();
  await f.request(ext('tools/list'), { sessionId: id, extensionName: 'probe' });
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
  await f.request(ext('tools/list'), { sessionId: id, extensionName: 'probe' });
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

test('closing and deleting imported history releases capabilities without creating native sessions', { timeout: 15_000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-lifecycle-history-')), secret = 'isolated-lifecycle-history-secret';
  const store = await openStore(root);
  await store.update(s => s.sessions.push({ id: 'imported', title: 'Retained history', readonlyHistory: true, cwd: root, type: 'user', updates: [], usageUpdates: [], messageCount: 0 }));
  await store.flush();
  const releases = [];
  const driver = {
    async createSession() { assert.fail('Imported history must not create a native session'); },
    async configureSession() { assert.fail('Imported history must not configure a native session'); },
    async releaseNativeSessionCapabilities(id) { releases.push(id); },
    async close() {},
  };
  const app = await createCompatServer({ dataDir: root, secret, driver }), base = await app.listen();
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
  assert.deepEqual(releases, ['imported', 'imported']);
  const reopened = await openStore(root);
  assert.equal(reopened.read().sessions.some(session => session.id === 'imported'), false);
});
