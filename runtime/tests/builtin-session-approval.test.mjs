import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { browserTool } from '../browser-tool.mjs';
import { desktopPetTool } from '../desktop-pet-tool.mjs';
import { ProjectMemory } from '../memory.mjs';
import { createHarnessDriver } from '../harness/index.mjs';
import { Compat } from '../compat.mjs';
import { openStore } from '../store.mjs';
import { SafetyPolicy } from '../safety-policy.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codebuddy-builtin-approval-')));
  const driver = await createHarnessDriver({ dataDir: join(root, 'native'), cwd: root });
  t.after(() => driver.close());
  const store = await openStore(join(root, 'host'));
  const host = Object.assign(Object.create(Compat.prototype), {
    store, settings: { extensions: async () => [{ configKey: 'projectmemory', enabled: true, extension: { type: 'platform', name: 'projectmemory' } }] }, active: new Map(), safety: new SafetyPolicy(store),
  });
  const memory = new ProjectMemory(driver), questions = [], dispatches = [];
  const provider = { id: 'offline', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'unused' };
  const f = { root, driver, store, questions, dispatches, choice: 'allow_always',
    tools(s, owner = host) {
      return [browserTool({ sessionId: s.id, cwd: s.cwd, requestOwner: owner, request: async (_method, input) => {
        dispatches.push(input); return { id: 'fixture-tab', url: 'http://127.0.0.1/fixture' };
      } }), desktopPetTool({ cwd: s.cwd, directory: join(root, 'pets') }), ...memory.tools(s)];
    },
    async session() {
      const s = { id: randomUUID(), cwd: root, type: 'code_pro', workspaceBinding: 'writable_project' };
      await store.update(state => state.sessions.push(s));
      await driver.createSession({ sessionId: s.id, cwd: root, provider, model: 'offline', options: { tools: f.tools(s) } });
      return s;
    },
    invoke(s, name, args) {
      return driver.callTool(s.id, name, args, {
        onToolPolicy: call => host.toolPolicy(s, call, call.signal),
        onPermission: call => host.approveTool(s, call, { async ask(_method, params) {
          questions.push(params);
          return { outcome: { outcome: 'selected', optionId: f.choice } };
        } }, call.signal),
      });
    },
  };
  return f;
}

const cases = [
  ['browser_control', { operation: 'open', url: 'http://127.0.0.1/fixture' }, { operation: 'observe', id: 'fixture-tab' }],
  ['create_desktop_pet', { operation: 'prepare' }, { operation: 'prepare' }],
  ['project_memory', { action: 'retain', subject: 'Fixture', content: 'Candidate only' }, { action: 'recall' }],
];

test('builtin grants are per tool and conversation and survive equivalent next-turn configuration', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.session();
  for (const [name, first, next] of cases) {
    const count = f.questions.length;
    const result = await f.invoke(s, name, first);
    assert.equal(result.isError, false, name + ': ' + JSON.stringify(result));
    assert.equal(f.questions.length, count + 1, 'Each tool requires its own explicit choice');
    assert.ok(f.questions.at(-1).options.some(option => option.optionId === 'allow_always'));
    assert.equal(f.questions.at(-1)._meta.codepro.authorizationScope, 'session');
    await f.driver.configureSession(s.id, { tools: f.tools(s) });
    const second = await f.invoke(s, name, next);
    assert.equal(second.isError, false, JSON.stringify(second));
    assert.equal(f.questions.length, count + 1, 'A new host callback closure does not erase the grant');
    if (name === 'project_memory') assert.deepEqual(second.value.records, [], 'Tool permission never approves candidate memories');
    if (name === 'create_desktop_pet') assert.equal(second.value.automaticallySelected, false);
  }
  const count = f.questions.length;
  for (const [name, , next] of cases) await f.invoke(s, name, next);
  assert.equal(f.questions.length, count, 'All three grants remain independent across reconfiguration');
  assert.equal(f.store.read(['toolPermissions']).toolPermissions, undefined, 'No global grants are saved');
  const other = await f.session();
  f.choice = 'reject_once';
  for (const [name, args] of cases) assert.equal((await f.invoke(other, name, args)).isError, true);
  assert.equal(f.questions.length, count + cases.length);
});

test('browser once, explicit policies, replacement, removal and host changes retain approval boundaries', { timeout: 30000 }, async t => {
  const f = await fixture(t), s = await f.session();
  const invoke = () => f.invoke(s, 'browser_control', { operation: 'observe', id: 'fixture-tab' });
  f.choice = 'allow_once';
  await invoke(); await invoke();
  assert.equal(f.questions.length, 2);
  f.choice = 'allow_always'; await invoke();
  await f.store.update(state => { state.toolPermissions = { browser_control: 'never_allow' }; });
  const count = f.questions.length, dispatches = f.dispatches.length;
  assert.equal((await invoke()).isError, true);
  assert.equal(f.questions.length, count);
  assert.equal(f.dispatches.length, dispatches);
  await f.store.update(state => { state.toolPermissions = { browser_control: 'ask_before' }; });
  f.choice = 'reject_once';
  assert.equal((await invoke()).isError, true);
  assert.equal(f.questions.at(-1).options.some(option => option.optionId === 'allow_always'), false);
  await f.store.update(state => { state.toolPermissions = {}; });
  await f.driver.configureSession(s.id, { tools: f.tools(s, {}) });
  assert.equal((await invoke()).isError, true, 'A different browser owner needs fresh approval');
  await f.driver.configureSession(s.id, { tools: f.tools(s) });
  assert.equal((await invoke()).isError, true, 'Returning to an old owner does not restore its revoked grant');
  f.choice = 'allow_always'; await invoke();
  await f.driver.configureSession(s.id, { tools: [] });
  await f.driver.configureSession(s.id, { tools: f.tools(s) });
  f.choice = 'reject_once';
  assert.equal((await invoke()).isError, true);
  const fake = { ...f.tools(s)[0], execute() { throw Error('Must not dispatch'); } };
  await f.driver.configureSession(s.id, { tools: [fake] });
  assert.equal((await invoke()).isError, true);
  assert.equal(f.questions.at(-1).options.some(option => option.optionId === 'allow_always'), false,
    'A same-name replacement cannot manufacture the trusted host capability');
});

test('releasing session capabilities invalidates all builtin grants before reactivation', async t => {
  const f = await fixture(t), s = await f.session();
  for (const [name, args] of cases) assert.equal((await f.invoke(s, name, args)).isError, false);
  assert.equal(f.questions.length, cases.length);
  await f.driver.releaseNativeSessionCapabilities(s.id);
  await f.driver.configureSession(s.id, { tools: f.tools(s) });
  f.choice = 'reject_once';
  for (const [name, args] of cases) assert.equal((await f.invoke(s, name, args)).isError, true);
  assert.equal(f.questions.length, cases.length * 2);
});

test('module settings revoke affected host grants while unrelated MCP settings retain them', async t => {
  const f = await fixture(t), s = await f.session();
  for (const [name, args] of cases) await f.invoke(s, name, args);
  await f.driver.invalidateMcpServers(['custom_mcp']);
  await f.driver.configureSession(s.id, { tools: f.tools(s) });
  for (const [name, , args] of cases) await f.invoke(s, name, args);
  assert.equal(f.questions.length, 3);
  await f.driver.invalidateMcpServers(['developer']);
  await f.driver.configureSession(s.id, { tools: f.tools(s) });
  for (const [name, , args] of cases) await f.invoke(s, name, args);
  assert.equal(f.questions.length, 5, 'Browser and pet reset; project memory stays authorized');
});
