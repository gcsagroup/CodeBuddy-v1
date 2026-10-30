import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../store.mjs';
import { Compat } from '../compat.mjs';
import { permissionDriver } from './fixtures/permission-driver.mjs';
import { workspaceAgent, agentAllowsTool, validateAgentProfile } from '../agent-profiles.mjs';
import { resolveSessionExtensions } from '../session-extensions.mjs';
import { toolEnabled } from '../tool-policy.mjs';

const profile = { name: 'Research partner', avatar: '🔬', providerId: 'fixture', modelId: 'fixed', prompt: 'ROLE_MARKER: Explain evidence carefully.', skills: ['research'], tools: ['read', 'skill'], mcpServers: ['approved'] };
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-profile-')));
  const store = await openStore(root);
  await store.update(state => {
    state.providers = [{ id: 'fixture', displayName: 'Fixture', models: ['fixed', 'other'], engine: 'openai_compatible', apiUrl: 'http://127.0.0.1:1', requiresAuth: false }];
    state.defaults = { providerId: 'fixture', modelId: 'other' };
  });
  const driver = { close: async () => {}, permissions: permissionDriver(), listTools: async () => [{ name: 'read' }, { name: 'write' }, { name: 'skill' }] };
  const host = new Compat(store, driver);
  const connection = { notify() {} };
  const request = (action, input = {}) => host.request(`_codebuddy/agents/${action}`, input, connection);
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, host, connection, request };
}

test('workspace snapshots survive profile edits, deletion, reopening and nested conversations; models cannot be overridden', async t => {
  const f = await fixture(t);
  const catalog = await f.request('catalog');
  assert.deepEqual(catalog.models.map(m => m.modelId), ['fixed', 'other']);
  assert.ok(catalog.tools.some(tool => tool.name === 'read'));
  assert.ok(!JSON.stringify(catalog).includes('apiUrl'));
  const { profile: saved } = await f.request('save', { profile });
  const created = await f.request('create-workspace', { id: saved.id });
  const session = f.store.readSession(created.sessionId);
  assert.equal(session.modelId, 'fixed');
  assert.equal(session.title, profile.name);
  assert.deepEqual(session.agentProfile, saved);
  assert.deepEqual(created.configOptions, []);
  const options = await f.host.sessionOptions(session);
  assert.match(options.systemPrompt, /ROLE_MARKER/);
  assert.deepEqual(options.toolFilter.allow, ['read', 'skill']);
  assert.deepEqual(options.subagentModels, {});
  assert.deepEqual(options.subagentTemplates, []);
  await assert.rejects(f.host.request('session/set_config_option', { sessionId: session.id, configId: 'model', value: 'other' }, f.connection), /fixed model/);
  await assert.rejects(f.host.request('_goose/unstable/session/system-prompt/set', { sessionId: session.id, text: 'replace role', mode: 'set' }, f.connection), /fixed persona/);
  await assert.rejects(f.host.request('_goose/unstable/session/extensions/add', { sessionId: session.id, extension: { type: 'mcp', server: { name: 'approved' } } }, f.connection), /fixed services/);
  await f.request('save', { profile: { ...saved, prompt: 'NEW_ROLE', modelId: 'other' } });
  await assert.rejects(f.request('save', { profile: saved }), /edited elsewhere/);
  await f.request('delete', { id: saved.id });
  const reopened = await openStore(f.root);
  assert.deepEqual(await workspaceAgent(reopened, session.cwd), saved);
  const nested = path.join(session.cwd, 'nested'); await mkdir(nested);
  const second = await f.host.request('session/new', { cwd: nested, mcpServers: [] }, f.connection);
  assert.deepEqual(f.store.readSession(second.sessionId).agentProfile, saved);
  await assert.rejects(f.host.request('session/new', { cwd: nested, mcpServers: [{ name: 'approved', url: 'http://evil.invalid' }] }, f.connection), /configured tools/);
  assert.equal(await workspaceAgent(f.store, f.root), null);
});

test('role tool and MCP selection intersects global availability and rejects injected session servers', async () => {
  const entries = ['developer', 'approved', 'other'].map(name => ({ configKey: name, enabled: true, extension: name === 'developer' ? { name, type: 'builtin' } : { type: 'mcp', server: { name } } }));
  const settings = { extensions: async () => entries };
  const session = { id: 's', type: 'code_pro', agentProfile: profile, mcpServers: [{ name: 'injected' }] };
  const resolved = await resolveSessionExtensions(session, settings);
  assert.deepEqual(resolved.selected.map(e => e.configKey), ['developer', 'approved']);
  assert.deepEqual(resolved.mcpServers, []);
  assert.equal(await toolEnabled(session, settings, 'read'), true);
  for (const name of ['write', 'codebuddy_task', 'mcp__other__call', 'mcp__injected__call']) assert.equal(await toolEnabled(session, settings, name), false);
  assert.equal(await toolEnabled(session, settings, 'mcp__approved__call'), true);
  entries[1].enabled = false;
  assert.equal(await toolEnabled(session, settings, 'mcp__approved__call'), false);
  assert.equal(agentAllowsTool({ tools: [], mcpServers: [] }, 'read'), false);
  assert.equal(agentAllowsTool({ tools: [], mcpServers: [], skills: ['research'] }, 'skill'), true);
  assert.equal(agentAllowsTool({ tools: ['skill'], mcpServers: [], skills: [] }, 'skill'), false);
  assert.throws(() => validateAgentProfile({ ...profile, tools: null }), /tools/);
  assert.throws(() => validateAgentProfile({ ...profile, avatar: '<svg onload=evil>' }), /avatar/);
});

test('failed creation releases its empty workspace and binding without falling back to another model', async t => {
  const f = await fixture(t);
  const { profile: saved } = await f.request('save', { profile });
  await f.store.update(state => { state.providers[0].models = ['other']; });
  await assert.rejects(f.request('create-workspace', { id: saved.id }), /available default model/);
  assert.deepEqual(f.store.read(['agentWorkspaces']).agentWorkspaces, {});
  assert.deepEqual(f.store.read(['sessions']).sessions, []);
  assert.deepEqual(await readdir(path.join(f.root, 'workspaces')), []);
});


test('logo and uploaded PNG avatars persist in workspace snapshots; unsafe avatar inputs are rejected', async t => {
  const f = await fixture(t);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=';
  assert.equal(validateAgentProfile({ ...profile, avatar: 'app-logo' }).avatar, 'app-logo');
  const { profile: saved } = await f.request('save', { profile: { ...profile, avatar: png } });
  const created = await f.request('create-workspace', { id: saved.id });
  assert.equal(f.store.readSession(created.sessionId).agentProfile.avatar, png);
  assert.equal(f.store.readSession(created.sessionId).title, profile.name);
  const reopened = await openStore(f.root);
  assert.equal((await workspaceAgent(reopened, f.store.readSession(created.sessionId).cwd)).avatar, png);
  for (const avatar of ['https://example.com/avatar.png', 'data:image/svg+xml,<svg/>', 'data:image/png;base64,YQ==', 'x'.repeat(350001)])
    assert.throws(() => validateAgentProfile({ ...profile, avatar }), /avatar/);
});
