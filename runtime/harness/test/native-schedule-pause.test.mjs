import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessDriver } from '../index.mjs';
import { setPaused } from '../native-schedule-pause-method.mjs';

const pauseRequest = (row, paused) => {
  const { sessionId, status, lastDelivery: _delivery, ...expected } = row;
  return { id: row.id, sessionId, expected, expectedStatus: status, paused };
};
const rowOf = async (driver, id) => (await driver.nativeScheduleRequest('catalog')).records.find(row => row.id === id);

test('pause survives restart, skips missed occurrences on the original cadence and preserves identity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-pause-'));
  let activations = 0;
  let driver;
  const start = async () => {
    driver = await createHarnessDriver({ dataDir: join(root, 'harness'), cwd: root });
    await driver.startNativeSchedules({ prepareSession: () => { activations++; throw Error('Unexpected delivery'); } });
  };
  try {
    await start();
    const { record } = await driver.nativeScheduleRequest('create', { sessionId: 'original-chat',
      request: { title: 'Repeated reminder', prompt: 'fixture', every_seconds: 60 } });
    const original = await rowOf(driver, record.id);
    const input = pauseRequest(original, true);
    const wrong = await driver.nativeScheduleRequest('set-paused', { ...input, sessionId: 'other-chat' });
    assert.equal(wrong.code, 'schedule_not_found');
    await assert.rejects(driver.nativeScheduleRequest('set-paused', { ...input, paused: 'true' }));
    assert.equal((await driver.nativeScheduleRequest('set-paused', input)).status, 'paused');
    // An old visible button cannot overwrite a later state transition.
    assert.equal((await driver.nativeScheduleRequest('set-paused', input)).code, 'schedule_conflict');
    await driver.close(); driver = null;
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(record.scheduledAt) + 125000 });
    await start();
    let row = await rowOf(driver, record.id);
    assert.equal(row.status, 'paused');
    assert.equal(row.sessionId, 'original-chat');
    assert.equal(activations, 0);
    const { sessionId, status, lastDelivery, ...expected } = row;
    await driver.nativeScheduleRequest('update', { sessionId, id: row.id, expected, title: 'Edited while paused' });
    row = await rowOf(driver, record.id);
    assert.equal(row.status, 'paused');
    assert.equal(row.scheduledAt, original.scheduledAt);
    assert.equal((await driver.nativeScheduleRequest('set-paused', pauseRequest(row, false))).status, 'active');
    row = await rowOf(driver, record.id);
    assert.equal(row.id, original.id);
    assert.equal(row.sessionId, original.sessionId);
    assert.equal(Date.parse(row.scheduledAt), Date.parse(original.scheduledAt) + 180000);
    assert(Date.parse(row.scheduledAt) > Date.now());
    assert.equal(activations, 0);
    assert.deepEqual((await driver.nativeScheduleRequest('history', { sessionId, id: row.id, limit: 20 })).records, []);
    await driver.nativeScheduleRequest('set-paused', pauseRequest(row, true));
    // Native archive stop must not orphan a resumable task in a closed chat.
    await driver.nativeScheduleRequest('stop-session', { sessionId });
    assert.equal(await rowOf(driver, row.id), undefined);
  } finally { await driver?.close(); t.mock.timers.reset(); }
});

test('pausing a one-shot suppresses its timer and resuming an expired one-shot never replays it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-pause-once-'));
  const driver = await createHarnessDriver({ dataDir: join(root, 'harness'), cwd: root });
  let activations = 0;
  try {
    await driver.startNativeSchedules({ prepareSession: () => { activations++; throw Error('Unexpected delivery'); } });
    const { record } = await driver.nativeScheduleRequest('create', { sessionId: 'chat',
      request: { title: 'One shot', prompt: 'fixture', after_seconds: 1 } });
    await driver.nativeScheduleRequest('set-paused', pauseRequest(await rowOf(driver, record.id), true));
    await new Promise(resolve => setTimeout(resolve, 1300));
    assert.equal(activations, 0);
    const result = await driver.nativeScheduleRequest('set-paused', pauseRequest(await rowOf(driver, record.id), false));
    assert.equal(result.status, 'inactive');
    assert.equal(activations, 0);
    assert.equal((await driver.nativeScheduleRequest('set-paused', pauseRequest(await rowOf(driver, record.id), false))).code, 'schedule_ended');
  } finally { await driver.close(); }
});

test('chat controls share the persisted state without extra approval or cross-chat access', async t => {
  const observations = [];
  t.mock.method(console, 'info', (tag, value) => {
    if (tag === '[schedule-control-timing]') observations.push(JSON.parse(value));
  });
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-pause-tools-'));
  const driver = await createHarnessDriver({ dataDir: join(root, 'harness'), cwd: root });
  try {
    await driver.startNativeSchedules();
    const { sessionId } = await driver.createSession({ cwd: root,
      provider: { id: 'fixture', protocol: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'unused-fixture' }, model: 'fixture' });
    await driver.permissions(sessionId, { preset: 'read-only' });
    const own = await driver.nativeScheduleRequest('create', { sessionId, request: { title: 'Own reminder', prompt: 'fixture', every_seconds: 3600 } });
    const other = await driver.nativeScheduleRequest('create', { sessionId: 'other-chat', request: { title: 'Other reminder', prompt: 'fixture', every_seconds: 3600 } });
    const options = { onPermission: () => { throw Error('Unexpected approval request'); } };
    const paused = await driver.callTool(sessionId, 'schedule_pause', { id: own.record.id }, options);
    assert.equal(paused.isError, false, JSON.stringify(paused));
    assert.equal(paused.value.status, 'paused');
    const listed = await driver.callTool(sessionId, 'schedule_status', {}, options);
    assert.equal(listed.value.length, 1);
    assert.equal(listed.value[0].status, 'paused');
    const denied = await driver.callTool(sessionId, 'schedule_pause', { id: other.record.id }, options);
    assert.equal(denied.value.code, 'schedule_not_found');
    const resumed = await driver.callTool(sessionId, 'schedule_resume', { id: own.record.id }, options);
    assert.equal(resumed.value.status, 'active');
    assert.equal((await driver.permissions(sessionId)).preset, 'read-only');
    for (const action of ['pause', 'resume']) {
      const trace = observations.filter(row => row.taskId === own.record.id && row.action === action);
      assert.deepEqual(trace.map(row => row.stage),
        ['queued', 'queue_entered', 'persist_started', 'persist_finished', 'finished']);
      assert.equal(new Set(trace.map(row => row.operationId)).size, 1);
      assert(trace.every(row => Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0));
      assert.equal(trace.at(-1).changed, true);
    }
    assert(!JSON.stringify(observations).includes('Own reminder'));
    assert(!JSON.stringify(observations).includes('fixture'));

  } finally { await driver.close(); }
});

test('diagnostic failure cannot change a control receipt or replace the native failure', async t => {
  t.mock.method(console, 'info', () => { throw Error('logger unavailable'); });
  const request = { id: 'missing', sessionId: 'chat', paused: true };
  const owner = { serialize: fn => fn(), getDomain: async () => ({ table: () => new Map() }) };
  assert.deepEqual(await setPaused.call(owner, request),
    { id: 'missing', changed: false, code: 'schedule_not_found' });
  const original = Error('native queue failure');
  await assert.rejects(setPaused.call({ serialize: async () => { throw original; } }, request),
    error => error === original);
});
