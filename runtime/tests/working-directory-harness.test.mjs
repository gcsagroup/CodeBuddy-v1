import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, access, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarnessDriver } from '../harness/index.mjs';
import { createConversationDriver } from '../conversation-driver.mjs';
import { openStore } from '../store.mjs';

async function fixture(t, { outsideTemp = false } = {}) {
  const base = outsideTemp ? fileURLToPath(new URL('../../.preview-evidence/', import.meta.url)) : tmpdir();
  await mkdir(base, { recursive: true });
  const root = await realpath(await mkdtemp(path.join(base, 'codebuddy-directory-harness-'))), dirA = path.join(root, 'a'), dirB = path.join(root, 'b'), dirC = path.join(root, 'c');
  for (const [dir, label] of [[dirA, 'A'], [dirB, 'B'], [dirC, 'C']]) { await mkdir(path.join(dir, '.git'), { recursive: true }); await writeFile(path.join(dir, 'AGENTS.md'), `DIRECTORY_${label}_INSTRUCTIONS: use ${label} project conventions.`); }
  const requests = [], slow = Promise.withResolvers();
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part; const body = JSON.parse(raw); requests.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'cwd-fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    const content = JSON.stringify(body.messages);
    if (content.includes('SLOW_INPUT')) { emit({ role: 'assistant', content: 'waiting' }); slow.resolve(); return; }
    emit({ role: 'assistant', content: 'Observed project.' }); emit({}, 'stop'); res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = { id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture' }, dataDir = path.join(root, 'native');
  let rawDriver = await createHarnessDriver({ dataDir, cwd: root }), store = await openStore(path.join(root, 'product')), driver = createConversationDriver(rawDriver, store);
  t.after(async () => { await driver.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const create = async (id, cwd) => driver.createSession({ sessionId: id, cwd, provider, model: 'fixture' });
  await store.update(state => state.sessions.push({ id: 'product', cwd: dirA, type: 'user', directoryChanges: [] }));
  await create('product', dirA);
  return { root, dirA, dirB, dirC, provider, requests, slow, get driver() { return driver; }, get rawDriver() { return rawDriver; }, get store() { return store; }, create,
    async publish(cwd) {
      return driver.withConversationLock('product', async () => {
        const previousNativeSessionId = driver.nativeSessionId('product');
        const result = await driver.forkWorkingDirectory('product', cwd);
        await store.update(state => { const session = state.sessions[0]; session.cwd = result.cwd; session.nativeSessionId = result.sessionId; session.directoryChanges.push({ previousNativeSessionId, nativeSessionId: result.sessionId }); });
        await driver.releaseNativeSessionCapabilities(previousNativeSessionId); return result;
      });
    },
    async restart() { await driver.close(); rawDriver = await createHarnessDriver({ dataDir, cwd: root }); store = await openStore(path.join(root, 'product')); driver = createConversationDriver(rawDriver, store); },
  };
}

test('official immutable directory fork preserves facts and history while native tools, sandbox and AGENTS use the new root across restart', { timeout: 30_000 }, async t => {
  const f = await fixture(t, { outsideTemp: true });
  await f.driver.prompt('product', 'KEEP_OLD_USER_HISTORY');
  assert.equal((await f.driver.callTool('product', 'write', { file_path: 'before.txt', content: 'A file' }, { onPermission: () => true })).isError, false);
  const original = await f.rawDriver.history('product'), moved = await f.publish(f.dirB);
  assert.equal(moved.cwd, f.dirB); assert.notEqual(moved.sessionId, 'product');
  assert.deepEqual((await f.rawDriver.history('product')).events, original.events);
  assert.equal((await f.driver.history('product')).meta.cwd, f.dirB);
  await f.create('product', f.dirB);
  const approvals = [];
  assert.equal((await f.driver.callTool('product', 'write', { file_path: 'after.txt', content: 'B file' }, { onToolStart: call => { approvals.push(call); } })).isError, false);
  assert.equal(approvals[0].sessionId, 'product'); assert.equal(await readFile(path.join(f.dirB, 'after.txt'), 'utf8'), 'B file');
  await assert.rejects(access(path.join(f.dirA, 'after.txt')));
  const forbidden = await f.driver.callTool('product', 'write', { file_path: path.join(f.dirA, 'outside-denied.txt'), content: 'old workspace access' }, { onPermission: () => true });
  assert.equal(forbidden.isError, true); assert.match(JSON.stringify(forbidden), /sandbox/i);
  await assert.rejects(access(path.join(f.dirA, 'outside-denied.txt')));
  const read = await f.driver.callTool('product', 'read', { file_path: 'after.txt' }, { onPermission: () => true }); assert.equal(read.isError, false); assert.match(JSON.stringify(read), /B file/);
  await f.driver.prompt('product', 'AFTER_MOVE_HISTORY');
  assert.match(JSON.stringify(f.requests.at(-1).messages), /KEEP_OLD_USER_HISTORY/);
  const current = await f.driver.history('product'), instructions = current.events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'agent-instructions').at(-1);
  assert.match(JSON.stringify(instructions.data), /DIRECTORY_B_INSTRUCTIONS/);
  const wire = f.requests.at(-1).messages.map(message => typeof message.content === 'string' ? message.content : message.content?.map(part => part.text ?? '').join('\n')).join('\n');
  assert.ok(wire.includes(`Current working directory: ${JSON.stringify(f.dirB)}`), 'current directory context contains the new root');
  assert.ok(wire.includes(`session workspace: ${JSON.stringify(f.dirB)}`), 'sandbox context uses the same new workspace root');
  assert.equal((await f.driver.listSessions()).filter(session => (session.id ?? session.sessionId) === 'product').length, 1);
  await f.restart(); await f.create('product', f.dirB);
  assert.equal((await f.driver.callTool('product', 'write', { file_path: 'restarted.txt', content: 'Still B' }, { onPermission: () => true })).isError, false);
  assert.equal(await readFile(path.join(f.dirB, 'restarted.txt'), 'utf8'), 'Still B');
  assert.match(JSON.stringify((await f.driver.history('product')).events), /KEEP_OLD_USER_HISTORY/);
  await f.publish(f.dirC); await f.create('product', f.dirC);
  assert.equal((await f.driver.callTool('product', 'write', { file_path: 'third.txt', content: 'C file' }, { onPermission: () => true })).isError, false);
  assert.equal(await readFile(path.join(f.dirC, 'third.txt'), 'utf8'), 'C file');
});

test('directory fork validates existing directories without creating them and leaves original identity usable on failure', async t => {
  const f = await fixture(t), missing = path.join(f.root, 'missing'), file = path.join(f.root, 'a-file'); await writeFile(file, 'file');
  for (const target of [missing, file, 'relative/path']) await assert.rejects(f.driver.forkWorkingDirectory('product', target), /existing directory|absolute path/);
  await assert.rejects(access(missing)); assert.equal(f.driver.nativeSessionId('product'), 'product');
  const blank = await f.driver.forkWorkingDirectory('product', f.dirB); assert.equal((await f.rawDriver.history(blank.sessionId)).meta.cwd, f.dirB);
  assert.equal((await f.driver.prompt('product', 'Still original')).stopReason, 'end_turn');
});

test('directory fork rejects an active native prompt and approval still applies after switching', { timeout: 30_000 }, async t => {
  const f = await fixture(t), controller = new AbortController();
  const running = f.driver.prompt('product', 'SLOW_INPUT', { signal: controller.signal }); await f.slow.promise;
  await assert.rejects(f.driver.forkWorkingDirectory('product', f.dirB), /active session operation/);
  controller.abort(); assert.equal((await running).stopReason, 'cancelled');
  await f.publish(f.dirB); await f.create('product', f.dirB);
  await f.driver.permissions('product', { preset: 'read-only' });
  const result = await f.driver.callTool('product', 'write', { file_path: 'denied.txt', content: 'denied' }); assert.equal(result.isError, true); await assert.rejects(access(path.join(f.dirB, 'denied.txt')));
});

test('a directory fork can be reopened through a filesystem alias without adopting a different workspace', async t => {
  const f = await fixture(t, { outsideTemp: true }), alias = path.join(f.root, 'b-alias');
  await symlink(f.dirB, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const moved = await f.publish(alias);
  assert.equal(moved.cwd, f.dirB);
  assert.equal((await f.create('product', alias)).cwd, f.dirB);
  await f.restart();
  assert.equal((await f.create('product', alias)).cwd, f.dirB);
  await assert.rejects(f.create('product', f.dirC), error => error.code === 'session/conflict');
  assert.equal((await f.driver.callTool('product', 'write', { file_path: 'alias.txt', content: 'same workspace' }, { onPermission: () => true })).isError, false);
  assert.equal(await readFile(path.join(f.dirB, 'alias.txt'), 'utf8'), 'same workspace');
});
