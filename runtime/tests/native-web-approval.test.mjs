import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessDriver } from '../harness/index.mjs';
import { Compat } from '../compat.mjs';
import { openStore } from '../store.mjs';
import { SafetyPolicy } from '../safety-policy.mjs';

test('native web session grants are origin-scoped and keep the upstream network fence', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-origin-grant-'));
  const driver = await createHarnessDriver({ dataDir: join(root, 'harness'), cwd: root });
  t.after(() => driver.close());
  const store = await openStore(join(root, 'backend'));
  const provider = { id: 'offline', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'unused' };
  const host = Object.assign(Object.create(Compat.prototype), { store, settings: { extensions: async () => [] }, active: new Map(), safety: new SafetyPolicy(store) });
  const questions = [], calls = [];
  let answer = 'allow_always';
  const connection = { async ask(_method, params) {
    questions.push(params);
    return { outcome: { outcome: 'selected', optionId: answer } };
  } };
  async function session(options) {
    const created = await driver.createSession({ cwd: root, provider, model: 'offline', options });
    const s = { id: created.sessionId, type: 'code_pro', workspaceBinding: 'writable_project', cwd: root };
    await store.update(state => { state.preferences.gooseMode = 'smart_approve'; state.sessions.push(s); });
    return s;
  }
  const s = await session();
  const invoke = (s, name, args = {}) => driver.callTool(s.id, name, args, {
    onToolPolicy: call => { calls.push(call); return host.toolPolicy(s, call, call.signal); },
    onPermission: call => host.approveTool(s, call, connection, call.signal),
  });

  const deps = await invoke(s, 'load_workspace_dependencies');
  assert.equal(deps.isError, false);
  assert.ok(deps.value.python);
  await invoke(s, 'load_workspace_dependencies');
  assert.equal(questions.length, 0, 'Existing bundled paths are read-only, not an install permission');

  const first = await invoke(s, 'web_fetch', { url: 'http://127.0.0.1:9/a' });
  assert.equal(first.isError, true);
  assert.match(JSON.stringify(first), /non-public|WEB_BLOCKED_URL/);
  assert.equal(questions.length, 1);
  assert.ok(questions[0].options.some(o => o.optionId === 'allow_always'));
  assert.match(questions[0].toolCall.content[0].content.text, /http:\/\/127\.0\.0\.1:9/);
  await invoke(s, 'web_fetch', { url: 'http://127.0.0.1:9/b?q=next' });
  assert.equal(questions.length, 1, 'A later call to the same origin consumes the existing grant');
  for (const url of ['http://127.0.0.1:10/a', 'https://127.0.0.1:9/a', 'http://127.0.0.2:9/a']) {
    await invoke(s, 'web_fetch', { url });
  }
  assert.equal(questions.length, 4, 'Port, protocol and host each define a separate grant');
  const other = await session();
  await invoke(other, 'web_fetch', { url: 'http://127.0.0.1:9/a' });
  assert.equal(questions.length, 5, 'Another conversation cannot inherit a grant');

  answer = 'allow_once';
  await invoke(s, 'web_fetch', { url: 'http://127.0.0.3:9/a' });
  await invoke(s, 'web_fetch', { url: 'http://127.0.0.3:9/b' });
  assert.equal(questions.length, 7, 'Once is not promoted into a session grant');
  const granted = calls.find(c => c.sessionApproval?.targetOrigin === 'http://127.0.0.1:9');
  assert.equal(await host.approveTool(s, { ...granted, delegated: true }, connection), true);
  const ungranted = { ...granted, sessionApproval: { ...granted.sessionApproval, tool: Object.freeze({}) }, delegated: true };
  assert.equal((await host.toolPolicy(s, ungranted)).kind, 'ask', 'The native child policy will reject a required approval before reaching an answerer');

  await store.update(state => { state.toolPermissions = { web_fetch: 'never_allow' }; });
  assert.equal(await host.approveTool(s, granted, connection), false, 'An explicit prohibition overrides the remembered grant');
  await store.update(state => { state.toolPermissions = {}; });
  answer = 'reject_once';
  const beforeShell = questions.length;
  const shell = await invoke(s, 'pwsh', { command: 'Write-Output native-workspace-command', description: 'Print isolated native command marker' });
  assert.equal(shell.isError, false, JSON.stringify(shell));
  assert.equal(shell.value.exitCode, 0);
  assert.equal(questions.length, beforeShell, 'The native sandbox authorizes its own command independently of the network grant');

  const replaced = await session({ tools: ['web_fetch','load_workspace_dependencies'].map(name => ({ name, inputSchema: { type: 'object', properties: { url: { type: 'string' } } }, execute() { throw Error('must not run'); } })) });
  await invoke(replaced, 'web_fetch', { url: 'http://127.0.0.1:9/a' });
  assert.equal(calls.at(-1).sessionApproval, undefined, 'A same-name replacement cannot inherit the native capability');
  await invoke(replaced, 'load_workspace_dependencies');
  assert.equal(calls.at(-1).readOnly, false, 'Only the reviewed dependency implementation is read-only');
});
