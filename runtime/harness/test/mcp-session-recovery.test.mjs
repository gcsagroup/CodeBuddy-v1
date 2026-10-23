import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarnessDriver } from '../index.mjs';
import { statefulMcp, until } from './fixtures/stateful-mcp.mjs';

async function fixture(t, options) {
  const remote = await statefulMcp(t, options);
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-mcp-recovery-'));
  const driver = await createHarnessDriver({ dataDir: path.join(root, 'data'), cwd: root });
  t.after(async () => {
    await driver.close();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const mcp = { serverName: 'Hex', transport: 'streamable-http', url: `${remote.baseUrl}/mcp`, reconnect: { initialDelayMs: 100, maxDelayMs: 400, maxAttempts: 3 }, headers: { 'Mcp-Session-Id': 'obsolete-saved-id', Authorization: 'Bearer fixture' } };
  const session = async (servers = [mcp]) => (await driver.createSession({ sessionId: randomUUID(), cwd: root, provider: { id: 'fixture', baseUrl: `${remote.baseUrl}/v1`, apiKey: 'fixture' }, model: 'fixture', options: { mcpServers: servers } })).sessionId;
  const call = id => driver.callTool(id, 'mcp__Hex__health', {}, { onPermission: async () => true });
  return { ...remote, driver, mcp, session, call };
}

for (const status of [404, 400]) test(`HTTP ${status} expiry reconnects once, refreshes schemas and does not replay calls`, async t => {
  const f = await fixture(t), id = await f.session();
  assert.equal((await f.call(id)).isError, false);
  f.control.status = status; f.expire();
  assert.equal((await f.call(id)).isError, true);
  assert.equal(f.driver.extensionStatus(id)[0].status, 'error');
  await until(() => f.driver.extensionStatus(id)[0].status === 'ready' && f.initializations() === 2);
  assert.equal(f.wire.filter(x => x.method === 'tools/call').length, 2, 'recovery must not replay the rejected call');
  assert.equal(f.executions(), 1);
  assert.match((await f.driver.listTools(id)).find(x => x.name === 'mcp__Hex__health').description, /Generation 2/);
  assert.equal((await f.call(id)).isError, false);
  assert.equal(f.wire.at(-1).sessionId, 'fixture-session-2');
  assert.ok(f.wire.filter(x => x.method === 'initialize').every(x => x.sessionId === undefined));
  assert.ok(f.wire.every(x => x.authorization === 'Bearer fixture'));
});

test('concurrent resource rejections share one reconnect and disabled reconnect can be recovered by explicit reconfiguration', async t => {
  const f = await fixture(t), id = await f.session();
  f.expire();
  const calls = await Promise.allSettled([1, 2, 3].map(() => f.driver.listResources(id, 'Hex', undefined, { onPermission: async () => true })));
  assert.ok(calls.every(x => x.status === 'rejected'));
  await until(() => f.initializations() === 2 && f.driver.extensionStatus(id)[0].status === 'ready');
  await delay(250); assert.equal(f.initializations(), 2);
  assert.deepEqual((await f.driver.listResources(id, 'Hex', undefined, { onPermission: async () => true })).resources, []);
  const stopped = await f.session([{ ...f.mcp, reconnect: { enabled: false } }]);
  f.expire(); assert.equal((await f.call(stopped)).isError, true);
  await f.driver.configureSession(stopped, { mcpServers: [] });
  await f.driver.configureSession(stopped, { mcpServers: [f.mcp] });
  assert.equal((await f.call(stopped)).isError, false);
});

test('manual invalidation renews the matching preset, preserves leased peers and keeps healthy unrelated presets warm', async t => {
  const f = await fixture(t), first = await f.session(), peer = await f.session();
  const other = { ...f.mcp, serverName: 'other' }; await f.session([other]);
  assert.equal(f.initializations(), 2);
  await f.driver.invalidateMcpServers(['hex']);
  const next = await f.session(); assert.equal(f.initializations(), 3);
  assert.equal((await f.call(peer)).isError, false);
  assert.equal(f.wire.at(-1).sessionId, 'fixture-session-1');
  assert.equal((await f.call(next)).isError, false);
  assert.equal(f.wire.at(-1).sessionId, 'fixture-session-3');
  await f.session([other]); assert.equal(f.initializations(), 3);
  await f.driver.configureSession(first, { mcpServers: [] });
  await f.driver.configureSession(first, { mcpServers: [f.mcp] });
  assert.equal(f.initializations(), 4);
});

test('tool errors, generic HTTP errors and uncertain network outcomes never cause automatic replay', async t => {
  const f = await fixture(t), id = await f.session();
  f.control.toolError = true; assert.equal((await f.call(id)).isError, true); f.control.toolError = false;
  for (const [status, message] of [[400, 'Invalid request'], [401, 'Session not found'], [500, 'Session not found']]) {
    Object.assign(f.control, { fault: true, status, message });
    assert.equal((await f.call(id)).isError, true);
    await delay(150); assert.equal(f.initializations(), 1);
  }
  f.control.fault = false; f.control.drop = true;
  assert.equal((await f.call(id)).isError, true);
  await delay(150); assert.equal(f.initializations(), 1);
  assert.equal(f.executions(), 2, 'a lost response must not repeat an already executed operation');
});

test('stateless HTTP 404 does not start a session-recovery loop', async t => {
  const f = await fixture(t, { stateless: true }), id = await f.session();
  f.control.fault = true;
  assert.equal((await f.call(id)).isError, true);
  await delay(250); assert.equal(f.initializations(), 1);
});

test('expiry while polling an accepted task reconnects without resubmitting the task', async t => {
  const f = await fixture(t); f.control.tasks = true;
  const id = await f.session();
  const result = await f.call(id);
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /remote final state is unconfirmed/);
  await until(() => f.initializations() === 2 && f.driver.extensionStatus(id)[0].status === 'ready');
  assert.equal(f.wire.filter(x => x.method === 'tools/call').length, 1);
  assert.equal(f.executions(), 1);
  assert.ok(f.wire.some(x => x.method === 'tasks/get'));
});

test('failed handshakes exhaust the configured retry budget and explicit re-enable recovers', async t => {
  const f = await fixture(t), id = await f.session();
  f.control.rejectInitialize = true; f.expire();
  assert.equal((await f.call(id)).isError, true);
  await until(() => f.initializations() === 4);
  await delay(500); assert.equal(f.initializations(), 4);
  assert.equal(f.driver.extensionStatus(id)[0].status, 'error');
  f.control.rejectInitialize = false;
  await f.driver.configureSession(id, { mcpServers: [] });
  await f.driver.configureSession(id, { mcpServers: [f.mcp] });
  assert.equal((await f.call(id)).isError, false);
});

test('disposing the driver cancels pending session recovery', async t => {
  const f = await fixture(t), id = await f.session([{ ...f.mcp, reconnect: { initialDelayMs: 300, maxDelayMs: 300 } }]);
  f.expire(); assert.equal((await f.call(id)).isError, true);
  await f.driver.close();
  await delay(450); assert.equal(f.initializations(), 1);
});
