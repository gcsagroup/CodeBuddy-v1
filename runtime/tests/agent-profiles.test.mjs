import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../store.mjs';
import { Compat } from '../compat.mjs';
import { permissionDriver } from './fixtures/permission-driver.mjs';
import { workspaceAgent, agentAllowsTool, validateAgentProfile, bindAgentInput, agentInputProfile, createAgentSelection } from '../agent-profiles.mjs';
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

test('default templates are read-only catalog entries and become independent profiles only when saved', async t => {
  const f = await fixture(t);
  const before = f.store.read(['agentProfiles']);
  const catalog = await f.request('catalog');
  assert.equal(catalog.presets.length, 6);
  assert.deepEqual(f.store.read(['agentProfiles']), before, 'viewing default templates must not seed user data');
  for (const preset of catalog.presets) {
    assert.equal(preset.profile.capabilities, 'inherit');
    assert.equal(Object.hasOwn(preset.profile, 'modelId'), false);
    assert.ok(preset.profile.skills.every(name => catalog.skills.some(skill => skill.name === name)));
  }
  const { id, revision, ...copy } = catalog.presets[0].profile;
  await assert.rejects(f.request('save', { profile: catalog.presets[0].profile }), /read-only/);
  await assert.rejects(f.request('delete', { id }), /read-only/);
  const { profile: first } = await f.request('save', { profile: copy });
  const { profile: second } = await f.request('save', { profile: copy });
  assert.notEqual(first.id, second.id);
  assert.deepEqual(first.skills, catalog.presets[0].profile.skills);
  await f.request('delete', { id: first.id });
  const again = await f.request('catalog');
  assert.equal(again.presets.length, 6);
  assert.deepEqual((await f.request('list')).profiles.map(p => p.id), [second.id], 'deleted copies are not regenerated');
});

test('built-in agents apply directly without creating profiles and retain their input snapshot after restart', async t => {
  const f = await fixture(t);
  const { sessionId } = await f.host.request('session/new', { cwd: f.root, mcpServers: [] }, f.connection);
  const before = f.store.readSession(sessionId);
  const { presets } = await f.request('list');
  const choice = presets[0].profile;
  for (let expectedRevision = 0; expectedRevision < 2; expectedRevision++) {
    const result = await f.request('select', { sessionId, id: choice.id, expectedRevision });
    assert.equal(result.selection.profile.id, choice.id);
  }
  await bindAgentInput(f.store, sessionId, 'builtin-input');
  assert.deepEqual((await f.request('list')).profiles, []);
  assert.equal(f.store.read(['sessions']).sessions.length, 1);
  const after = f.store.readSession(sessionId);
  for (const key of ['cwd', 'modelId', 'providerId', 'title']) assert.equal(after[key], before[key]);
  const reopened = await openStore(f.root);
  assert.deepEqual(agentInputProfile(reopened.readSession(sessionId), 'builtin-input'), choice);
  const next = await f.host.request('session/new', { cwd: f.root, mcpServers: [], _meta: { customAgentId: choice.id } }, f.connection);
  assert.equal((await f.request('current', { sessionId: next.sessionId })).selection.profile.id, choice.id);
  await f.store.update(state => { state.providers = []; state.defaults = {}; });
  const { id, revision, ...draft } = presets[1].profile;
  assert.ok((await f.request('save', { profile: draft })).profile.id, 'creating a custom agent requires no model connection');
});

test('conversation roles keep model and workspace independent, and native inputs keep their original role after edits and restart', async t => {
  const f = await fixture(t);
  const created = await f.host.request('session/new', { cwd: f.root, mcpServers: [] }, f.connection);
  const before = f.store.readSession(created.sessionId);
  const { profile: backend } = await f.request('save', { profile: { ...profile, name: '后端助手', providerId: '', modelId: '', capabilities: 'inherit' } });
  assert.equal(Object.hasOwn(backend, 'modelId'), false);
  const selected = await f.request('select', { sessionId: before.id, id: backend.id, expectedRevision: 0 });
  assert.equal(selected.selection.profile.id, backend.id);
  const bound = await bindAgentInput(f.store, before.id, 'native-request-a');
  assert.equal(bound.id, backend.id);
  await f.request('save', { profile: { ...backend, prompt: 'EDITED_ROLE' } });
  await f.request('select', { sessionId: before.id, id: null, expectedRevision: 1 });
  assert.deepEqual(await bindAgentInput(f.store, before.id, 'native-request-a'), bound);
  await bindAgentInput(f.store, before.id, 'native-request-b');
  await assert.rejects(f.request('select', { sessionId: before.id, id: backend.id, expectedRevision: 1 }), /changed/);
  const after = f.store.readSession(before.id);
  assert.equal(after.cwd, before.cwd);
  assert.equal(after.modelId, before.modelId);
  assert.equal(after.title, before.title);
  assert.equal(after.agentProfile, before.agentProfile);
  const reopened = await openStore(f.root);
  assert.deepEqual(agentInputProfile(reopened.readSession(before.id), 'native-request-a'), bound);
  assert.equal(agentInputProfile(reopened.readSession(before.id), 'native-request-b'), null);
  assert.throws(() => agentInputProfile(reopened.readSession(before.id), 'missing-request'), /no saved agent configuration/);
});

test('reapplying a changed built-in without a new revision cannot overwrite a historical input snapshot', async t => {
  const f = await fixture(t);
  const { sessionId } = await f.host.request('session/new', { cwd: f.root, mcpServers: [] }, f.connection);
  const { presets } = await f.request('list');
  const earlier = { ...presets[0].profile, prompt: 'Earlier shipped instructions, same declared revision.' };
  await f.store.updateSession(sessionId, session => {
    session.agentSelection = createAgentSelection(earlier);
    session.agentInputs = { 'historical-input': `${earlier.id}:${earlier.revision}` };
  });
  await assert.rejects(f.request('select', { sessionId, id: earlier.id, expectedRevision: 1 }), /without a new revision/);
  const reopened = await openStore(f.root);
  assert.deepEqual(agentInputProfile(reopened.readSession(sessionId), 'historical-input'), earlier);
  assert.equal(reopened.readSession(sessionId).agentSelection.revision, 1);
});

test('the first role selection preserves a user input still preparing outside native Inbox', async t => {
  const f = await fixture(t);
  const created = await f.host.request('session/new', { cwd: f.root, mcpServers: [] }, f.connection);
  const { profile: saved } = await f.request('save', { profile: { ...profile, capabilities: 'inherit' } });
  assert.equal(await bindAgentInput(f.store, created.sessionId, 'preparing-input'), null);
  await f.request('select', { sessionId: created.sessionId, id: saved.id, expectedRevision: 0 });
  assert.equal(agentInputProfile(f.store.readSession(created.sessionId), 'preparing-input'), null);
  assert.equal(await bindAgentInput(f.store, created.sessionId, 'preparing-input', { profile: saved }), null);
  assert.equal((await bindAgentInput(f.store, created.sessionId, 'next-input')).id, saved.id);
});

test('obsolete template model preferences never block saves or change conversation models', async t => {
  const f = await fixture(t);
  const { profile: saved } = await f.request('save', { profile: { ...profile, providerId: 'deleted-provider', modelId: 'deleted-model' } });
  assert.equal(Object.hasOwn(saved, 'providerId'), false);
  assert.equal(Object.hasOwn(saved, 'modelId'), false);
  const { sessionId } = await f.host.request('session/new', { cwd: f.root, mcpServers: [], _meta: { customAgentId: saved.id } }, f.connection);
  assert.equal(f.store.readSession(sessionId).modelId, 'other');
  await f.host.request('session/set_config_option', { sessionId, configId: 'model', value: 'fixed' }, f.connection);
  assert.equal(f.store.readSession(sessionId).modelId, 'fixed');
  assert.equal((await f.request('current', { sessionId })).selection.profile.id, saved.id);
});

test('a role stays pending during workspace preparation and after rejected native admission', async t => {
  const f = await fixture(t);
  const { sessionId } = await f.host.request('session/new', { cwd: f.root, mcpServers: [] }, f.connection);
  const { profile: first } = await f.request('save', { profile: { ...profile, name: 'First' } });
  const { profile: next } = await f.request('save', { profile: { ...profile, name: 'Next' } });
  await f.store.updateSession(sessionId, session => {
    session.type = 'code_pro'; session.agentSelection = createAgentSelection(first);
    session.agentInputs = { 'old-input': `${first.id}:1` };
  });
  f.host.driver.agentInputIds = async () => ['old-input'];
  let prompts = 0;
  f.host.driver.prompt = async () => { prompts++; throw Error('Native must not run'); };
  await f.request('select', { sessionId, id: next.id, expectedRevision: 1 });
  const entered = Promise.withResolvers(), gate = Promise.withResolvers();
  f.host.workspaces.validateSession = async () => { entered.resolve(); await gate.promise; };
  const pending = f.host.prompt({ sessionId, prompt: [{ type: 'text', text: 'Do the task.' }] }, f.connection);
  const rejected = assert.rejects(pending, /EXPECTED_WORKSPACE_FAILURE/);
  await entered.promise;
  const during = await f.request('current', { sessionId });
  gate.reject(Error('EXPECTED_WORKSPACE_FAILURE'));
  await rejected;
  assert.equal(during.effective.id, first.id);
  assert.equal(during.pending, true);
  const after = await f.request('current', { sessionId });
  assert.equal(after.effective.id, first.id);
  assert.equal(after.pending, true);
  assert.equal(prompts, 0);
});

test('concurrent role changes accept one revision and never combine two choices', async t => {
  const f = await fixture(t);
  const { sessionId } = await f.host.request('session/new', { cwd: f.root, mcpServers: [] }, f.connection);
  const { profile: first } = await f.request('save', { profile: { ...profile, name: 'First' } });
  const { profile: second } = await f.request('save', { profile: { ...profile, name: 'Second' } });
  const results = await Promise.allSettled([first, second].map(choice => f.request('select', { sessionId, id: choice.id, expectedRevision: 0 })));
  const accepted = results.filter(result => result.status === 'fulfilled');
  const rejected = results.filter(result => result.status === 'rejected');
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /changed/);
  const current = await f.request('current', { sessionId });
  assert.equal(current.selection.revision, 1);
  assert.deepEqual(current.selection.profile, accepted[0].value.selection.profile);
  assert.deepEqual(await bindAgentInput(f.store, sessionId, 'next-input'), current.selection.profile);
});

test('editing and deleting a selected template leaves its adopted conversation snapshot usable and reversible', async t => {
  const f = await fixture(t);
  const { sessionId } = await f.host.request('session/new', { cwd: f.root, mcpServers: [] }, f.connection);
  const { profile: original } = await f.request('save', { profile: { ...profile, capabilities: 'inherit' } });
  await f.request('select', { sessionId, id: original.id, expectedRevision: 0 });
  await f.request('save', { profile: { ...original, prompt: 'EDITED_TEMPLATE', capabilities: 'selected', tools: [] } });
  assert.deepEqual((await f.request('current', { sessionId })).selection.profile, original);
  await f.request('delete', { id: original.id });
  assert.deepEqual((await f.request('list')).profiles, []);
  assert.deepEqual((await f.request('current', { sessionId })).selection.profile, original);
  assert.deepEqual(await bindAgentInput(f.store, sessionId, 'after-deletion'), original);
  const reopened = await openStore(f.root);
  assert.deepEqual(agentInputProfile(reopened.readSession(sessionId), 'after-deletion'), original);
  await f.request('select', { sessionId, id: null, expectedRevision: 1 });
  assert.equal(await bindAgentInput(f.store, sessionId, 'default-input'), null);
});

test('pending follows the last admitted native input while idle and after cold restore', async t => {
  const f = await fixture(t);
  const created = await f.host.request('session/new', { cwd: f.root, mcpServers: [] }, f.connection);
  const { profile: first } = await f.request('save', { profile: { ...profile, name: 'First' } });
  const { profile: next } = await f.request('save', { profile: { ...profile, name: 'Next' } });
  let admitted = [], queued = [];
  f.host.driver.agentInputIds = async (_id, options) => options?.committedOnly ? admitted : [...admitted, ...queued];
  await f.request('select', { sessionId: created.sessionId, id: first.id, expectedRevision: 0 });
  await bindAgentInput(f.store, created.sessionId, 'input-a');
  admitted = ['input-a'];
  await f.request('select', { sessionId: created.sessionId, id: next.id, expectedRevision: 1 });
  await bindAgentInput(f.store, created.sessionId, 'queued-input');
  queued = ['queued-input'];
  let status = await f.request('current', { sessionId: created.sessionId });
  assert.equal(status.effective.id, first.id);
  assert.equal(status.selection.profile.id, next.id);
  assert.equal(status.pending, true);
  const reopened = await openStore(f.root);
  const restored = new Compat(reopened, f.host.driver);
  try {
    status = await restored.request('_codebuddy/agents/current', { sessionId: created.sessionId }, f.connection);
    assert.equal(status.effective.id, first.id);
    assert.equal(status.pending, true);
    admitted = ['input-a', 'queued-input'];
    status = await restored.request('_codebuddy/agents/current', { sessionId: created.sessionId }, f.connection);
    assert.equal(status.effective.id, next.id);
    assert.equal(status.pending, false);
  } finally { await restored.close(); }
});

test('legacy conversion is explicit and preserves its adopted snapshot and capability floor', async t => {
  const f = await fixture(t);
  const { profile: original } = await f.request('save', { profile });
  const created = await f.request('create-workspace', { id: original.id });
  const before = f.store.readSession(created.sessionId);
  await f.request('save', { profile: { ...original, prompt: 'NEW_TEMPLATE', tools: ['write'] } });
  await f.request('delete', { id: original.id });
  await assert.rejects(f.request('select', { sessionId: before.id, id: null, expectedRevision: 0 }), /Convert this legacy/);
  const converted = await f.request('convert', { sessionId: before.id, expectedRevision: 0 });
  assert.equal(converted.selection.legacy, false);
  assert.deepEqual(converted.selection.profile, original);
  const after = f.store.readSession(before.id);
  for (const field of ['id', 'cwd', 'title', 'providerId', 'modelId']) assert.equal(after[field], before[field]);
  assert.deepEqual(after.agentProfile, original);
  await f.request('select', { sessionId: before.id, id: null, expectedRevision: 1 });
  const options = await f.host.sessionOptions(f.store.readSession(before.id));
  assert.deepEqual(options.toolFilter.allow, ['read', 'skill']);
  await assert.rejects(f.request('convert', { sessionId: before.id, expectedRevision: 2 }), /no legacy/);
  await f.host.request('session/set_config_option', { sessionId: before.id, configId: 'model', value: 'other' }, f.connection);
  assert.equal(f.store.readSession(before.id).modelId, 'other');
});

test('legacy workspace snapshots keep their capability limits while model choice belongs to the conversation', async t => {
  const f = await fixture(t);
  const catalog = await f.request('catalog');
  assert.equal(Object.hasOwn(catalog, 'models'), false);
  assert.ok(catalog.tools.some(tool => tool.name === 'read'));
  assert.ok(!JSON.stringify(catalog).includes('apiUrl'));
  const { profile: saved } = await f.request('save', { profile });
  const created = await f.request('create-workspace', { id: saved.id });
  const session = f.store.readSession(created.sessionId);
  assert.ok((await f.request('workspaces')).directories.some(directory => path.resolve(directory).toLowerCase() === path.resolve(session.cwd).toLowerCase()));
  assert.equal(session.modelId, 'other');
  assert.equal(session.title, '新对话');
  assert.equal(created.workspaceName, profile.name);
  assert.equal(created.workingDir, session.cwd);
  assert.deepEqual(session.agentProfile, saved);
  assert.ok(created.configOptions.some(option => option.id === 'model'));
  const options = await f.host.sessionOptions(session);
  assert.match(options.mainAgentRole.baseline().prompt, /ROLE_MARKER/);
  assert.doesNotMatch(options.systemPrompt, /ROLE_MARKER/);
  assert.deepEqual(options.toolFilter.allow, ['read', 'skill']);
  assert.deepEqual(options.subagentModels, {});
  assert.deepEqual(options.subagentTemplates, []);
  await f.host.request('session/set_config_option', { sessionId: session.id, configId: 'model', value: 'fixed' }, f.connection);
  assert.equal(f.store.readSession(session.id).modelId, 'fixed');
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
  await f.store.update(state => { state.providers[0].models = ['fixed']; });
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
  assert.equal(f.store.readSession(created.sessionId).title, '新对话');
  const { profile: updated } = await f.request('save', { profile: { ...saved, avatar: '🦉' } });
  assert.equal(updated.avatar, '🦉');
  const reopened = await openStore(f.root);
  assert.equal((await workspaceAgent(reopened, f.store.readSession(created.sessionId).cwd)).avatar, png);
  for (const avatar of ['https://example.com/avatar.png', 'data:image/svg+xml,<svg/>', 'data:image/png;base64,YQ==', 'x'.repeat(350001)])
    assert.throws(() => validateAgentProfile({ ...profile, avatar }), /avatar/);
});
