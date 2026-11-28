import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import { createScope } from '@deepseek-ai/dsh-scope';
import { extendWin32ProcessBindings, isNullPtr, closeHandleChecked } from '@deepseek-ai/dsh-win32-process';
const { createHarnessDriver } = await import('../index.mjs');
const { privateNavigation } = await import('../mcp-bridge.mjs');
const { createCodeNavigationConnection } = await import('../code-navigation-connection.mjs');
const { createNavigationJob } = await import('../code-navigation-job.mjs');
const { developmentTools } = await import('../../development-tools.mjs');

const windows = process.platform === 'win32' && process.arch === 'x64';
const runtime = fileURLToPath(new URL('../../', import.meta.url));
const bootstrap = fileURLToPath(new URL('./fixtures/navigation-server.py', import.meta.url));
async function until(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(20); }
  throw Error('Navigation fixture condition timed out');
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-navigation-lifecycle-'));
  const ctx = new Context(), connections = [];
  ctx.provide('tools', { register() { assert.fail('Private raw MCP tools must not be projected'); } });
  ctx.provide('systemPrompt', { section() { assert.fail('Private server instructions must not be projected'); } });
  t.after(async () => {
    for (const connection of connections) await connection.close();
    await rm(root, { recursive: true, force: true });
  });
  const events = async () => {
    try { return (await readFile(join(root, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const connect = async (extra = {}) => {
    const scope = createScope(ctx, {});
    let handle;
    const plugin = scope.ctx.plugin(privateNavigation, {
      serverName: 'codebuddy_navigation', transport: 'stdio', cwd: root,
      command: join(runtime, 'py/dependencies/python/python.exe'),
      args: ['-I', '-B', bootstrap, '--runtime', runtime, '--workspace', root], env: {},
      backgroundStart: true, failOnStartupError: true, reconnect: { enabled: false },
      toolCallTimeoutMs: 10000, ...extra, onConnection(value) { handle = value; },
    });
    await plugin;
    assert.ok(handle);
    let closing;
    const connection = {
      request(operation, path, signal = t.signal) {
        return handle.request(operation, { relative_path: path, name_path: 'add', name_path_pattern: 'add', max_answer_chars: 18000 }, signal);
      },
      close() { return closing ??= (async () => { try { await handle.close(); } finally { await scope.dispose(); } })(); },
    };
    connections.push(connection);
    return connection;
  };
  const factory = () => {
    const connection = createCodeNavigationConnection({ ctx }, { runtime, workspace: root, state: join(root, 'state') });
    connections.push(connection);
    return {
      get retired() { return connection.retired; },
      request(operation, path, signal = t.signal) {
        return connection.request(operation, { relative_path: path, max_answer_chars: 18000 }, signal);
      },
      close: connection.close,
    };
  };
  return { root, connect, factory, events, own(resource) { connections.push(resource); } };
}
function resultOf(result) { assert.notEqual(result.isError, true); return JSON.parse(result.content.find(item => item.type === 'text').text); }
function observeExit(t, pid) {
  const api = extendWin32ProcessBindings(({ kernel32, bind }) => ({
    openProcess: bind(kernel32, 'OpenProcess', 'void *', ['uint32', 'int', 'uint32']),
  }));
  const handle = api.openProcess(0x00100000, 0, pid);
  if (isNullPtr(handle)) { assert.equal(api.getLastError(), 87); return async () => {}; }
  t.after(() => closeHandleChecked(api, handle, 'navigation test observer'));
  return () => until(() => api.waitForSingleObject(handle, 0) === 0);
}

test('private navigation reuses one process, serializes queries and never projects raw tools or instructions', { skip: !windows, timeout: 30000 }, async t => {
  const f = await fixture(t), connection = await f.connect();
  const results = await Promise.all(['overview', 'definition', 'references'].map(operation => connection.request(operation, 'slow')));
  assert.equal(new Set(results.map(result => resultOf(result).pid)).size, 1);
  assert.deepEqual(results.map(result => resultOf(result).operation), ['overview', 'definition', 'references']);
  const wire = await f.events();
  assert.equal(wire.filter(event => event.kind === 'bootstrap').length, 1);
  assert.deepEqual(wire.filter(event => event.kind.startsWith('query-')).map(event => event.kind), ['query-start', 'query-end', 'query-start', 'query-end', 'query-start', 'query-end']);
  const exited = observeExit(t, resultOf(results[0]).pid);
  await connection.close(); await exited();
});

test('canceling an in-flight query closes its exact descendant range before a new explicit connection', { skip: !windows, timeout: 30000 }, async t => {
  const f = await fixture(t), connection = await f.connect(), cancel = new AbortController();
  const running = connection.request('references', 'hold', cancel.signal);
  running.catch(() => {});
  const child = await until(async () => (await f.events()).find(event => event.kind === 'descendant'));
  const rootExited = observeExit(t, child.pid), childExited = observeExit(t, child.child);
  cancel.abort(new DOMException('Navigation fixture canceled', 'AbortError'));
  await assert.rejects(running);
  await connection.close(); await rootExited(); await childExited();
  const next = await f.connect(), nextResult = resultOf(await next.request('overview', 'normal'));
  assert.notEqual(nextResult.pid, child.pid);
  assert.equal((await f.events()).filter(event => event.kind === 'query-start' && event.path === 'hold').length, 1, 'Canceled query is not replayed');
});

test('startup cancellation before Job assignment observes the SDK root exit and allows a fresh connection', { skip: !windows, timeout: 30000 }, async t => {
  const f = await fixture(t), connection = await f.connect({ args: ['-I', '-B', bootstrap, '--runtime', runtime, '--workspace', f.root, '--before-join-ms', '15000'] });
  const cancel = new AbortController(), running = connection.request('overview', 'normal', cancel.signal);
  running.catch(() => {});
  const root = await until(async () => (await f.events()).find(event => event.kind === 'bootstrap'));
  const exited = observeExit(t, root.pid);
  cancel.abort(); await assert.rejects(running); await connection.close(); await exited();
  assert.equal((await f.events()).filter(event => event.kind === 'joined').length, 0);
  const next = await f.connect(); assert.equal(resultOf(await next.request('overview', 'normal')).path, 'normal');
});

test('a confirmed spawn failure does not turn an empty range into permanently unknown closure', { skip: !windows, timeout: 30000 }, async t => {
  const f = await fixture(t), connection = await f.connect({ command: join(f.root, 'missing-python.exe') });
  await assert.rejects(connection.request('overview', 'normal'));
  await connection.close();
  const next = await f.connect(); assert.equal(resultOf(await next.request('overview', 'normal')).path, 'normal');
});

test('a tool error keeps a healthy private connection and a peer session is not killed by cancellation', { skip: !windows, timeout: 30000 }, async t => {
  const f = await fixture(t), first = await f.connect(), peer = await f.connect();
  const original = resultOf(await first.request('overview', 'normal'));
  assert.equal((await first.request('definition', 'tool-error')).isError, true);
  assert.equal(resultOf(await first.request('overview', 'normal')).pid, original.pid);
  const other = resultOf(await peer.request('overview', 'normal'));
  await first.close();
  assert.equal(resultOf(await peer.request('references', 'normal')).pid, other.pid);
});

test('a crashed server is closed without replaying the query before a fresh connection', { skip: !windows, timeout: 30000 }, async t => {
  const f = await fixture(t), connection = await f.connect();
  await assert.rejects(connection.request('overview', 'crash'));
  await connection.close();
  const next = await f.connect(); await next.request('overview', 'normal');
  assert.equal((await f.events()).filter(event => event.kind === 'query-start' && event.path === 'crash').length, 1);
});

test('canceling a queued private query does not retire the healthy factory or dispatch the canceled query', { skip: !windows, timeout: 30000 }, async t => {
  const f = await fixture(t), apply = privateNavigation.apply;
  t.mock.method(privateNavigation, 'apply', function(ctx, config) {
    return apply(ctx, { ...config, args: ['-I', '-B', bootstrap, '--runtime', runtime, '--workspace', f.root] });
  });
  const connection = f.factory(), first = connection.request('overview', 'slow');
  first.catch(() => {});
  await until(async () => (await f.events()).some(event => event.kind === 'query-start'));
  const cancel = new AbortController(), queued = connection.request('overview', 'canceled-before-dispatch', cancel.signal);
  queued.catch(() => {}); cancel.abort();
  const original = resultOf(await first);
  await assert.rejects(queued);
  assert.equal(connection.retired, false);
  assert.equal(resultOf(await connection.request('overview', 'normal')).pid, original.pid);
  assert.equal((await f.events()).filter(event => event.path === 'canceled-before-dispatch').length, 0);
});

test('a factory retains explicit closure proof across a startup failure and permits a new instance', { skip: !windows, timeout: 30000 }, async t => {
  const f = await fixture(t), apply = privateNavigation.apply;
  let missing = true;
  t.mock.method(privateNavigation, 'apply', function(ctx, config) {
    return apply(ctx, { ...config, command: missing ? join(f.root, 'missing-python.exe') : config.command,
      args: ['-I', '-B', bootstrap, '--runtime', runtime, '--workspace', f.root] });
  });
  const failed = f.factory(); await assert.rejects(failed.request('overview', 'normal'));
  assert.equal(failed.retired, true); await failed.close();
  missing = false;
  const next = f.factory(); assert.equal(resultOf(await next.request('overview', 'normal')).path, 'normal');
});

test('driver navigation respects facade gates, recovers a new call after failure and closes when disabled', { skip: !windows, timeout: 30000 }, async t => {
  const f = await fixture(t), apply = privateNavigation.apply;
  let missing = true;
  t.mock.method(privateNavigation, 'apply', function(ctx, config) {
    return apply(ctx, { ...config, command: missing ? join(f.root, 'missing-python.exe') : config.command,
      args: ['-I', '-B', bootstrap, '--runtime', runtime, '--workspace', f.root] });
  });
  const workspace = join(f.root, 'workspace'), dataDir = join(f.root, 'data');
  await mkdir(workspace); await writeFile(join(workspace, 'sample.py'), 'def add(a, b): return a + b\n');
  await writeFile(join(f.root, 'outside.py'), 'private = 1\n');
  const driver = await createHarnessDriver({ dataDir, cwd: workspace }); f.own(driver);
  const tools = developmentTools({ cwd: workspace, dataDir });
  const { sessionId } = await driver.createSession({ cwd: workspace,
    provider: { id: 'not-called', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'fixture-only' },
    model: 'not-called', options: { tools },
  });
  const call = (path = 'sample.py', options = {}) => driver.callTool(sessionId, 'code_navigation', { operation: 'overview', path },
    { onPermission: async () => true, ...options });
  assert.equal((await call('sample.py', { onToolPolicy: () => ({ kind: 'ask' }), onPermission: async () => false })).isError, true);
  assert.equal((await call('../outside.py')).isError, true);
  assert.equal((await f.events()).length, 0, 'Consent and workspace gates precede startup');
  assert.equal((await call()).isError, true);
  missing = false;
  const original = resultOf(await call());
  const warm = [await call(), await call()];
  assert.ok(warm.every(result => resultOf(result).pid === original.pid));
  assert.equal((await f.events()).filter(event => event.kind === 'bootstrap').length, 1);
  assert.ok(!(await driver.listTools(sessionId)).some(tool => /mcp__codebuddy_navigation|destructive_raw_tool/.test(tool.name)));
  const exited = observeExit(t, original.pid);
  await driver.configureSession(sessionId, { tools: tools.filter(tool => tool.name !== 'code_navigation') });
  await exited();
  await driver.configureSession(sessionId, { tools });
  assert.notEqual(resultOf(await call()).pid, original.pid);
  assert.equal(await readFile(join(workspace, 'sample.py'), 'utf8'), 'def add(a, b): return a + b\n');
});

test('unknown startup closure stays unknown after owned handles are released and cannot admit a late bootstrap', { skip: !windows, timeout: 10000 }, async () => {
  const job = createNavigationJob();
  job.beginRoot();
  assert.equal(await job.close(() => {}), false);
  assert.equal(await job.close(() => assert.fail('A failed close must not replay cleanup')), false);
  assert.equal(job.empty(), false);
  assert.throws(() => job.trackRoot(process.pid), /retired/);
  const api = extendWin32ProcessBindings(({ kernel32, bind }) => ({
    openNamedJob: bind(kernel32, 'OpenJobObjectW', 'void *', ['uint32', 'int', 'str16']),
  }));
  const handle = api.openNamedJob(0x0001, 0, job.name);
  assert.equal(isNullPtr(handle), true, 'The failed generation no longer grants bootstrap admission');
  assert.equal(api.getLastError(), 2);
});
