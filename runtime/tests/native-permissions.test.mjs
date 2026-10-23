import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, access, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarnessDriver } from '../harness/index.mjs';
import { createConversationDriver } from '../conversation-driver.mjs';
import { Compat } from '../compat.mjs';
import { openStore } from '../store.mjs';
import { SafetyPolicy } from '../safety-policy.mjs';

const shell = process.platform === 'win32' ? 'pwsh' : 'bash';
const quoted = value => "'" + value.replaceAll("'", "''") + "'";
const text = message => typeof message.content === 'string' ? message.content :
  (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');

async function fixture(t) {
  // The native Windows sandbox needs an owned temporary workspace whose ACL
  // can be granted to its worker; repository drives may inherit Modify only.
  const fixtures = join(tmpdir(), 'codebuddy-native-permissions');
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(join(fixtures, 'native-permissions-'));
  const plans = new Map(), events = [], calls = [], questions = [];
  const plan = actions => { const key = 'NATIVE_PERMISSION_TEST_' + randomUUID(); plans.set(key, actions); return key; };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const index = body.messages.findLastIndex(message => message.role === 'user' && [...plans.keys()].some(key => text(message).includes(key)));
    const key = [...plans.keys()].find(candidate => text(body.messages[index] ?? { content: '' }).includes(candidate));
    const done = body.messages.slice(index + 1).filter(message => message.role === 'tool').length;
    const action = plans.get(key)?.[done];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = action ? { role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: action.name, arguments: JSON.stringify(action.arguments) } }] }
      : { role: 'assistant', content: 'Fixture task ended; see the actual tool receipt.' };
    for (const [value, finish_reason] of [[delta, null], [{}, action ? 'tool_calls' : 'stop']])
      res.write(`data: ${JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = { id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-only', protocol: 'openai-completions' };
  const store = await openStore(join(root, 'host'));
  let rawDriver = await createHarnessDriver({ dataDir: join(root, 'native'), cwd: root });
  let driver = createConversationDriver(rawDriver, store);
  const host = Object.assign(Object.create(Compat.prototype), { store, driver, settings: { extensions: async () => [] }, active: new Map(), safety: new SafetyPolicy(store) });
  t.after(async () => { await rawDriver?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const connection = { async ask(_method, request) { questions.push(request); return { outcome: { outcome: 'selected', optionId: 'reject_once' } }; } };
  const callbacks = session => ({
    onEvent: event => events.push(event),
    onToolPolicy: call => { calls.push(call); return host.toolPolicy(session, call, call.signal); },
    onPermission: call => host.approveTool(session, call, connection, call.signal),
  });
  async function session(mode) {
    const cwd = join(root, randomUUID()); await mkdir(cwd);
    // A retired product mode deliberately disagrees with the native choice.
    const session = { id: randomUUID(), nativeSessionId: randomUUID(), cwd, mode: 'approve', type: 'code_pro', workspaceBinding: 'writable_project', updates: [] };
    await store.update(state => state.sessions.push(session));
    await driver.permissions(session.id, { cwd, initialPreset: mode });
    await driver.createSession({ sessionId: session.id, cwd, provider, model: 'fixture' });
    return session;
  }
  const prompt = (session, key) => driver.prompt(session.id, key, callbacks(session));
  const delegate = (session, actions) => prompt(session, plan([{ name: 'subagent', arguments: { description: 'Isolated permission worker', prompt: plan(actions) } }]));
  const children = session => rawDriver.listSubagentChildren(session.nativeSessionId);
  return { root, store, provider, plans, plan, events, calls, questions, host, session, prompt, delegate, children,
    get driver() { return driver; }, get rawDriver() { return rawDriver; },
    async closeDriver() { await rawDriver.close(); rawDriver = undefined; },
  };
}
const command = value => ({ name: shell, arguments: { command: value, description: 'Isolated native permission regression', timeoutMs: 120000 } });
async function until(check, description, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(30); }
  throw new Error('Timeout: ' + description);
}

test('native workspace permission lets a child really wait 45 seconds despite the retired approval mode', { timeout: 80000 }, async t => {
  const f = await fixture(t), session = await f.session('workspace-write');
  const started = Date.now();
  await f.delegate(session, [command(process.platform === 'win32' ? "Start-Sleep -Seconds 45; Write-Output 'WAIT_FINISHED'" : "sleep 45; printf 'WAIT_FINISHED'")]);
  const children = await f.children(session);
  assert.equal(children.length, 1);
  const receipt = f.events.find(event => event.type === 'tool_result' && event.sessionId === children[0].id && event.name === shell);
  assert.ok(receipt && !receipt.isError);
  assert.equal(receipt.structuredContent.exitCode, 0);
  assert.match(JSON.stringify(receipt.result), /WAIT_FINISHED/);
  assert.ok(Date.now() - started >= 45000, 'The real command must finish its wait');
  assert.equal(f.questions.length, 0, 'Native permitted child commands need no CodeBuddy approval');
  assert.ok(f.calls.some(call => call.sessionId === session.id && call.delegated === false));
  const history = await f.rawDriver.history(children[0].id);
  assert.ok(history.events.some(event => event.type === 'approval/policy' && event.data.policy === 'never'));
});

test('stop a physically running child, continue the same child, then recover it in another Node process', { timeout: 45000 }, async t => {
  const f = await fixture(t), session = await f.session('workspace-write');
  const started = join(session.cwd, 'started.txt'), finished = join(session.cwd, 'must-not-finish.txt');
  const pending = f.delegate(session, [command(process.platform === 'win32'
    ? `Set-Content -LiteralPath ${quoted(started)} -Value started; Start-Sleep -Seconds 60; Set-Content -LiteralPath ${quoted(finished)} -Value finished`
    : `printf started > ${quoted(started)}; sleep 60; printf finished > ${quoted(finished)}`)]);
  await until(async () => { try { await access(started); return true; } catch { return false; } }, 'physical child command start');
  const [child] = await f.children(session);
  await f.driver.cancel(session.id);
  assert.equal((await pending).stopReason, 'cancelled');
  await assert.rejects(access(finished));
  const resumed = join(session.cwd, 'resumed.txt');
  const send = key => f.plan([{ name: 'send_message', arguments: { agent_id: child.id, message: key } }]);
  await f.prompt(session, send(f.plan([{ name: 'write', arguments: { file_path: resumed, content: 'resumed' } }])));
  assert.equal(await readFile(resumed, 'utf8'), 'resumed');
  assert.deepEqual((await f.children(session)).map(item => item.id), [child.id]);
  const recovered = join(session.cwd, 'recovered.txt');
  const key = send(f.plan([{ name: 'write', arguments: { file_path: recovered, content: 'recovered' } }]));
  await f.driver.permissions(session.id, { preset: 'read-only' });
  await f.closeDriver();
  const input = join(f.root, 'recovery.json');
  await writeFile(input, JSON.stringify({ root: f.root, session, provider: f.provider, key }));
  const processResult = await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/native-permission-recovery.mjs', import.meta.url)), input], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', chunk => { stdout += chunk; }); proc.stderr.on('data', chunk => { stderr += chunk; });
    proc.on('error', reject); proc.on('close', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(processResult.code, 0, processResult.stderr);
  assert.match(processResult.stdout, /RECOVERY_VERIFIED/);
  assert.equal(await readFile(recovered, 'utf8'), 'recovered', 'Existing child keeps its original native workspace permission after the root changes');
  await assert.rejects(access(finished));
});

test('concurrent chats keep separate native permissions and cannot address another chat child', { timeout: 30000 }, async t => {
  const f = await fixture(t), a = await f.session('read-only'), b = await f.session('workspace-write');
  const pathA = join(a.cwd, 'denied.txt'), pathB = join(b.cwd, 'allowed.txt');
  await Promise.all([
    f.delegate(a, [{ name: 'write', arguments: { file_path: pathA, content: 'must not write' } }]),
    f.delegate(b, [{ name: 'write', arguments: { file_path: pathB, content: 'allowed' } }]),
  ]);
  await assert.rejects(access(pathA));
  assert.equal(await readFile(pathB, 'utf8'), 'allowed');
  const [childA] = await f.children(a), [childB] = await f.children(b);
  assert.notEqual(childA.id, childB.id);
  await f.prompt(b, f.plan([{ name: 'send_message', arguments: { agent_id: childA.id, message: 'Unrelated chat must not inject this input' } }]));
  const denial = f.events.findLast(event => event.type === 'tool_result' && event.name === 'send_message');
  assert.ok(denial.isError);
  assert.equal(denial.error.info.code, 'UNAUTHORIZED');
  assert.equal((await f.driver.permissions(a.id)).preset, 'read-only');
  assert.equal((await f.driver.permissions(b.id)).preset, 'workspace-write');
  assert.equal(f.questions.length, 0, 'Native unattended denial must not create a misleading parent approval');
});
