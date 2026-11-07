import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../store.mjs';
import { Compat } from '../compat.mjs';
import { resolveSessionExtensions, sealSessionExtensions } from '../session-extensions.mjs';
import { mcpDiagnostic } from '../harness/mcp-diagnostics.mjs';

const ext = name => `_goose/unstable/${name}`;
const definition = (name, version = 1) => ({ type: 'mcp', server: { name, type: 'http', url: `http://127.0.0.1:1/v${version}` } });
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'toolbox-sync-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const cwd = path.join(root, 'project'); await mkdir(cwd);
  const store = await openStore(path.join(root, 'data'));
  const session = { id: 'chat', cwd, type: 'user', extensionSelection: 'follow', extensions: null,
    providerId: 'fixture', modelId: 'fixture', updates: [], messageCount: 0 };
  await store.update(state => {
    state.sessions = [session]; state.extensions = [];
    state.providers = [{ id: 'fixture', engine: 'openai_compatible', apiUrl: 'http://127.0.0.1:1', models: ['fixture'], requiresAuth: false }];
    state.defaults = { providerId: 'fixture', modelId: 'fixture' };
  });
  const prepared = [], invalidated = [];
  const driver = {
    async createSession(input) { prepared.push(input.options.mcpServers); },
    async listTools() { return []; }, extensionStatus() { return []; },
    async invalidateMcpServers(names) { invalidated.push(names); },
  };
  const host = new Compat(store, driver);
  const current = () => host.session('chat');
  const selected = async () => (await resolveSessionExtensions(current(), host.settings)).selected;
  return { store, host, current, selected, prepared, invalidated, root };
}

test('changes during an active turn are applied to the same conversation before the next turn', async t => {
  const f = await fixture(t);
  await f.host.ensureSession(f.current());
  f.host.active.set('chat', { driverStarted: true });
  await f.host.request(ext('config/extensions/add'), { extension: definition('new_tool'), enabled: true });
  await f.host.ensureSession(f.current());
  assert.equal(f.prepared.length, 1, 'do not replace an active turn capability scope');
  assert.equal((await f.host.request(ext('session/extensions/state'), { sessionId: 'chat' })).pending, true);
  f.host.active.delete('chat');
  await f.host.ensureSession(f.current());
  assert.equal(f.prepared.at(-1)[0].serverName, 'new_tool');
  await f.host.request(ext('config/extensions/update'), { configKey: 'new_tool', extension: definition('new_tool', 2), enabled: true });
  await f.host.ensureSession(f.current());
  assert.equal(f.prepared.at(-1)[0].url, 'http://127.0.0.1:1/v2');
  assert.equal((await f.host.request(ext('session/extensions/state'), { sessionId: 'chat' })).pending, false);
});

test('global deletion cannot resurrect historical definitions or explicit MCP server copies after restart', async t => {
  const f = await fixture(t), remote = definition('retired');
  await f.host.settings.saveExtension({ extension: remote, enabled: true });
  await f.store.update(async state => Object.assign(state.sessions[0], await sealSessionExtensions([remote], [remote.server]), { extensionSelection: 'custom' }));
  await f.host.settings.request('config/extensions/remove', { configKey: 'retired' });
  assert.deepEqual(await f.selected(), []);
  assert.deepEqual((await resolveSessionExtensions(f.current(), f.host.settings)).mcpServers, []);
  const restored = await openStore(path.join(f.root, 'data'));
  const host = new Compat(restored, {});
  assert.deepEqual((await resolveSessionExtensions(host.session('chat'), host.settings)).selected, []);
  await f.host.settings.saveExtension({ extension: definition('retired', 2), enabled: true });
  assert.equal((await f.selected())[0].extension.server.url, 'http://127.0.0.1:1/v2');
});

test('explicit custom ranges stay fixed; switching to follow works mid-turn without starting tools', async t => {
  const f = await fixture(t);
  await f.host.settings.saveExtension({ extension: definition('first'), enabled: true });
  await f.host.request(ext('session/extensions/mode'), { sessionId: 'chat', mode: 'custom' });
  await f.host.settings.saveExtension({ extension: definition('later'), enabled: true });
  assert.deepEqual((await f.selected()).map(e => e.configKey), ['first']);
  f.host.active.set('chat', { driverStarted: true });
  await f.host.request(ext('session/extensions/mode'), { sessionId: 'chat', mode: 'follow' });
  assert.deepEqual((await f.selected()).map(e => e.configKey), ['first', 'later']);
  assert.equal(f.prepared.length, 0);
  await f.store.update(state => { state.sessions[0].agentProfile = { mcpServers: ['first'] }; });
  await assert.rejects(f.host.request(ext('session/extensions/mode'), { sessionId: 'chat', mode: 'follow' }), /cannot change/);
  assert.deepEqual((await f.selected()).map(e => e.configKey), ['first']);
});

test('bounded diagnostics preserve dependency errors and redact configured credentials', () => {
  const cause = Error('Connection closed at https://host.invalid/mcp?token=hidden');
  const message = mcpDiagnostic(Error('Startup failed', { cause }), { env: { TOKEN: 'fixture-secret' } },
    "ImportError: cannot import name 'ModelWrapValidatorHandler' from 'pydantic'\nTOKEN=fixture-secret\nAuthorization: Bearer hidden-token");
  assert.match(message, /ModelWrapValidatorHandler/);
  for (const secret of ['fixture-secret', 'hidden-token', 'host.invalid']) assert.ok(!message.includes(secret));
  assert.ok(mcpDiagnostic(cause, {}, 'x'.repeat(9000)).length <= 4096);
});

test('connection retry is idle-only and cannot start tools from archived history', async t => {
  const f = await fixture(t);
  f.host.active.set('chat', { driverStarted: true });
  await assert.rejects(f.host.request(ext('session/extensions/retry'), { sessionId: 'chat' }), /current turn/);
  assert.equal(f.prepared.length, 0);
  f.host.active.delete('chat');
  await f.store.update(state => { state.sessions[0].archivedAt = new Date().toISOString(); });
  await assert.rejects(f.host.request(ext('session/extensions/retry'), { sessionId: 'chat' }), /cannot retry/);
  assert.equal(f.prepared.length, 0);
});

test('retry invalidates only failed selected connections and leaves healthy peers warm', async t => {
  const f = await fixture(t);
  for (const name of ['healthy', 'failed']) await f.host.settings.saveExtension({ extension: definition(name), enabled: true });
  f.invalidated.length = 0;
  f.host.driver.extensionStatus = () => [
    { serverName: 'healthy', status: 'ready' }, { serverName: 'failed', status: 'error' }, { serverName: 'unselected', status: 'error' },
  ];
  await f.host.request(ext('session/extensions/retry'), { sessionId: 'chat' });
  assert.deepEqual(f.invalidated, [['failed']]);
  assert.equal(f.prepared.length, 1);
});

test('a save racing session initialization cannot mark stale capabilities synchronized', async t => {
  const f = await fixture(t);
  await f.host.settings.saveExtension({ extension: definition('before'), enabled: true });
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const starting = new Promise(resolve => { entered = resolve; });
  f.host.driver.createSession = async input => {
    f.prepared.push(input.options.mcpServers);
    if (f.prepared.length === 1) { entered(); await gate; }
  };
  const preparing = f.host.ensureSession(f.current());
  await starting;
  await f.host.settings.saveExtension({ extension: definition('after'), enabled: true });
  release(); await preparing;
  assert.deepEqual(f.prepared.at(-1).map(s => s.serverName), ['before', 'after']);
  assert.equal((await f.host.request(ext('session/extensions/state'), { sessionId: 'chat' })).pending, false);
});

test('a scope change racing initialization is applied before readiness and legacy selections can be restored', async t => {
  const f = await fixture(t), legacy = definition('legacy');
  await f.host.settings.saveExtension({ extension: definition('global'), enabled: true });
  await f.store.update(async state => Object.assign(state.sessions[0], await sealSessionExtensions([legacy], [legacy.server]), { extensionSelection: 'custom' }));
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const starting = new Promise(resolve => { entered = resolve; });
  f.host.driver.createSession = async input => {
    f.prepared.push(input.options.mcpServers);
    if (f.prepared.length === 1) { entered(); await gate; }
  };
  const preparing = f.host.ensureSession(f.current());
  await starting;
  await f.host.request(ext('session/extensions/mode'), { sessionId: 'chat', mode: 'follow' });
  release(); await preparing;
  assert.deepEqual(f.prepared.at(-1).map(s => s.serverName), ['global']);
  const restored = await openStore(path.join(f.root, 'data'));
  const host = new Compat(restored, {});
  await host.request(ext('session/extensions/mode'), { sessionId: 'chat', mode: 'custom' });
  const snapshot = await resolveSessionExtensions(host.session('chat'), host.settings);
  assert.deepEqual(snapshot.selected.map(e => e.configKey), ['legacy']);
  assert.deepEqual(snapshot.mcpServers.map(s => s.name), ['legacy']);
});
