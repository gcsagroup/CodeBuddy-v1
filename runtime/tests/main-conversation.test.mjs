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
