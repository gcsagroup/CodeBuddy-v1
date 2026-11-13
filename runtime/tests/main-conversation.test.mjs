import { toolEnabled } from '../tool-policy.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../store.mjs';
import { Compat } from '../compat.mjs';
import { permissionDriver } from './fixtures/permission-driver.mjs';
import { workspaceMemoryTool } from '../main-conversation.mjs';

async function interruptedMain(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'main-recovery-test-')));
  const store = await openStore(root);
  await store.update(state => {
    state.providers = [{ id: 'fixture', models: ['fixed'], engine: 'openai_compatible', apiUrl: 'http://127.0.0.1:1', requiresAuth: false }];
    state.defaults = { providerId: 'fixture', modelId: 'fixed' };
  });
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 2, data: { source: { kind: 'user', rpcId: 'request-before-crash' } } },
    { type: 'tool/call', seq: 2, time: 3, data: { turn: 1 } },
    { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'interrupted' } } },
  ];
  let reads = 0;
  const driver = { permissions: permissionDriver(), close: async () => {}, listTools: async () => [],
    history: async () => { reads++; return { events }; } };
  const host = new Compat(store, driver);
  await host.initialize();
  t.after(() => host.close());
  const { sessionId } = await host.request('_codebuddy/main-conversation/ensure', {}, {});
  await store.updateSession(sessionId, session => {
    session.updates.push(
      { sessionUpdate: 'user_message_chunk', messageId: 'request-before-crash', content: { type: 'text', text: 'write once' } },
      { sessionUpdate: 'agent_message_chunk', messageId: 'partial', content: { type: 'text', text: 'Work saved before interruption' } },
    );
  });
  const notices = [];
  const load = async () => {
    notices.length = 0;
    await host.request('session/load', { sessionId }, { notify: (_method, params) => notices.push(params.update) });
    return notices.filter(update => update.status?.data?.stop_reason === 'process_interrupted');
  };
  return { host, store, sessionId, events, driver, load, reads: () => reads };
}

test('ordinary main chat consumes native interruption facts on load without creating an executor or changing saved work', async t => {
  const f = await interruptedMain(t);
  const saved = f.store.readSession(f.sessionId);
  let priorId;
  for (let i = 0; i < 2; i++) {
    const notices = await f.load();
    assert.equal(notices.length, 1);
    const data = notices[0].status.data;
    assert.equal(data.source_user_message_id, 'request-before-crash');
    assert.equal(data.tool_action_count, 1);
    assert.equal(data.visible_text_available, true);
    assert.equal(data.retry_strategy, 'not_available');
    if (priorId) assert.equal(data.terminal_message_id, priorId);
    priorId = data.terminal_message_id;
    assert.deepEqual(f.store.readSession(f.sessionId), saved);
    assert.equal(f.host.runs.latest(f.sessionId), null);
    assert.equal(f.host.active.size, 0);
  }
});

test('main chat recovery never turns normal native ends, newer requests, or read failures into interruption', async t => {
  const f = await interruptedMain(t);
  for (const kind of ['completed', 'aborted', 'error', 'forked', 'max-tokens']) {
    f.events.at(-1).data.reason = { kind };
    assert.equal((await f.load()).length, 0);
  }
  f.events.at(-1).data.reason = { kind: 'interrupted' };
  await f.store.updateSession(f.sessionId, session => {
    session.updates.push({ sessionUpdate: 'user_message_chunk', messageId: 'newer-request', content: { type: 'text', text: 'continue' } });
  });
  assert.equal((await f.load()).length, 0, 'an earlier native end cannot settle a newer ACP request');
  f.driver.history = async () => { throw Object.assign(Error('fixture native history unavailable'), { code: 'SESSION_NOT_FOUND' }); };
  assert.equal((await f.load()).length, 0, 'optional explanation failure must not block loading saved history');
});

test('main chat recovery skips live runs and readonly history', async t => {
  const f = await interruptedMain(t);
  f.host.active.set(f.sessionId, { replay: undefined, connection: { attach() {} } });
  assert.equal((await f.load()).length, 0);
  assert.equal(f.reads(), 0);
  f.host.active.delete(f.sessionId);
  await f.store.updateSession(f.sessionId, session => { session.readonlyHistory = true; });
  assert.equal((await f.load()).length, 0);
  assert.equal(f.reads(), 0);
});

test('one main conversation survives concurrent opens and reopening; only its tool recalls approved workspace memories', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'main-conversation-test-')));
  const store = await openStore(root);
  await store.update(state => {
    state.providers = [{ id: 'fixture', displayName: 'Fixture', models: ['fixed'], engine: 'openai_compatible', apiUrl: 'http://127.0.0.1:1', requiresAuth: false }];
    state.defaults = { providerId: 'fixture', modelId: 'fixed' };
  });
  const rows = new Map();
  const driver = { close: async () => {}, permissions: permissionDriver(), listTools: async () => [], memory: {
    list: async scope => [...rows.values()].filter(row => row.scope === scope),
    set: async (scope, key, value) => rows.set(JSON.stringify([scope, key]), { scope, key, value }),
    get: async (scope, key) => rows.get(JSON.stringify([scope, key])),
  } };
  const host = new Compat(store, driver);
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const ensure = () => host.request('_codebuddy/main-conversation/ensure', {}, { notify() {} });
  const [first, second] = await Promise.all([ensure(), ensure()]);
  assert.equal(first.sessionId, second.sessionId);
  const main = store.readSession(first.sessionId);
  assert.equal(main.globalConversation, true);
  assert.equal(main.type, 'user');
  assert.equal(main.cwd, path.join(root, 'main-conversation'));
  assert.equal(store.read(['sessions']).sessions.length, 1);
  assert.equal(host.info(main)._meta.globalConversation, true);
  const reopened = new Compat(await openStore(root), driver);
  assert.equal((await reopened.request('_codebuddy/main-conversation/ensure', {}, {})).sessionId, main.id);
  await reopened.close();
  await assert.rejects(host.request('_goose/unstable/session/working-dir/update', { sessionId: main.id, workingDir: root }), /not a project/);
  const project = path.join(root, 'project'); await mkdir(project);
  const unknown = path.join(root, 'unknown'); await mkdir(unknown);
  await store.update(state => { state.agentWorkspaces = { [project]: {} }; });
  const scope = await host.memory.scope(project);
  for (const [id, status, expiresAt] of [['approved', 'active'], ['candidate', 'candidate'], ['disabled', 'disabled'], ['expired', 'active', '2020-01-01T00:00:00Z']]) {
    await driver.memory.set(scope, 'record:' + id, { id, subject: id, content: id, status, updatedAt: '2026-01-01T00:00:00Z', expiresAt });
  }
  const tool = workspaceMemoryTool(host, main);
  assert.deepEqual((await tool.execute({})).workspaces, [project]);
  const recalled = await tool.execute({ workspace: project });
  assert.equal(recalled.workspace, project);
  assert.deepEqual(recalled.records.map(row => row.id), ['approved']);
  await assert.rejects(tool.execute({ workspace: unknown }), /registered workspace/);
  assert.equal(await toolEnabled(main, host.settings, 'workspace_memory'), true);
  assert.equal(await toolEnabled({ ...main, globalConversation: false }, host.settings, 'workspace_memory'), false);
  const options = await host.sessionOptions(main);
  assert.ok(options.tools.some(tool => tool.name === 'workspace_memory'));
  const ordinary = { ...main, id: 'ordinary', globalConversation: false, cwd: project };
  assert.ok(!(await host.sessionOptions(ordinary)).tools.some(tool => tool.name === 'workspace_memory'));
});
