import { replyToNoActionReview } from './review-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHarnessDriver } from '../index.mjs';

test('native Schedule owns rules and retains their identities across Host restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-native-schedule-'));
  let driver = await createHarnessDriver({ dataDir: join(root, 'harness'), cwd: root });
  try {
    await driver.startNativeSchedules({ prepareSession: () => { throw new Error('Future reminders must not activate a session'); } });
    await assert.rejects(driver.nativeScheduleRequest('create', { sessionId: 'fixture-session',
      request: { title: 'Too frequent', prompt: 'fixture', every_seconds: 59 } }));
    const { record } = await driver.nativeScheduleRequest('create', { sessionId: 'fixture-session',
      request: { title: 'Native task', prompt: 'fixture task', every_seconds: 3600 } });
    assert.equal(record.kind, 'every');
    assert.equal(record.everySeconds, 3600);
    const catalog = await driver.nativeScheduleRequest('catalog');
    assert.equal(catalog.records.length, 1);
    assert.equal(catalog.records[0].sessionId, 'fixture-session');
    const history = await driver.nativeScheduleRequest('history', { id: record.id, sessionId: 'fixture-session', limit: 20 });
    assert.deepEqual(history.records, []);
    const changed = await driver.nativeScheduleRequest('update', { id: record.id, sessionId: 'fixture-session', expected: record, title: 'Renamed natively' });
    assert.equal(changed.record.id, record.id);
    assert.equal(changed.record.title, 'Renamed natively');
    assert.equal(changed.record.scheduledAt, record.scheduledAt);
    await driver.close(); driver = null;
    driver = await createHarnessDriver({ dataDir: join(root, 'harness'), cwd: root });
    await driver.startNativeSchedules({ prepareSession: () => { throw new Error('Future reminders must not activate a session'); } });
    const restored = await driver.nativeScheduleRequest('catalog');
    assert.equal(restored.records[0].id, record.id);
    assert.equal(restored.records[0].title, 'Renamed natively');
    const wrong = await driver.nativeScheduleRequest('delete', { id: record.id, sessionId: 'another-session' });
    assert.equal(wrong.deleted, false);
    assert.equal((await driver.nativeScheduleRequest('catalog')).records.length, 1);
    const deleted = await driver.nativeScheduleRequest('delete', { id: record.id, sessionId: 'fixture-session' });
    assert.equal(deleted.deleted, true);
    assert.deepEqual((await driver.nativeScheduleRequest('catalog')).records, []);
  } finally { await driver?.close(); }
});


test('a native one-shot delivers once through the existing stream without injecting a second prompt', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-native-delivery-'));
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    if (replyToNoActionReview(body, response)) return;
    requests.push(body);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: '+JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'NATIVE_DELIVERY_OK' }, finish_reason: null }] })+'\n\n');
    response.end('data: '+JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })+'\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const driver = await createHarnessDriver({ dataDir: join(root, 'harness'), cwd: root });
  const observed = [], done = Promise.withResolvers();
  try {
    const { sessionId } = await driver.createSession({ cwd: root,
      provider: { id: 'fixture', protocol: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'unused-fixture-key' }, model: 'fixture' });
    await driver.startNativeSchedules({
      prepareSession: async id => { assert.equal(id, sessionId); },
      observe: async ({ sessionId: id, message, token }) => {
        observed.push(message);
        try {
          const result = await driver.prompt(id, message.content, {
            nativeObservationToken: token, onEvent: event => observed.push(event),
          });
          done.resolve(result);
        } catch (error) { done.reject(error); throw error; }
      },
    });
    const { record } = await driver.nativeScheduleRequest('create', { sessionId,
      request: { title: 'One native delivery', prompt: 'Reply NATIVE_DELIVERY_OK', after_seconds: 1 } });
    const result = await Promise.race([done.promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Native delivery observer did not settle')), 10000); timer.unref(); })]);
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(requests.length, 1);
    assert.equal(observed.filter(event => event.type === 'text_delta').map(event => event.text).join(''), 'NATIVE_DELIVERY_OK');
    const catalog = await driver.nativeScheduleRequest('catalog');
    assert.equal(catalog.records[0].status, 'inactive');
    const history = await driver.nativeScheduleRequest('history', { sessionId, id: record.id, limit: 20 });
    assert.equal(history.records.length, 1);
    const inspection = await driver.history(sessionId);
    const users = inspection.events.filter(event => event.type === 'user/message');
    assert.equal(users.filter(event => event.data.source?.kind === 'schedule').length, 1);
    assert.equal(users.filter(event => event.data.source?.kind === 'user').length, 0);
    assert.equal(users.find(event => event.data.source?.kind === 'schedule').data.id, observed[0].id);
  } finally {
    await driver.close();
    await new Promise(resolve => server.close(resolve));
  }
});
