import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessDriver } from '../harness/index.mjs';
import { contextUpdates } from '../context-updates.mjs';
import { zGooseSessionNotification_unstable } from '../../ui/sdk/src/generated/zod.gen.ts';

for (const measured of [true, false]) {
  test(`decode speed reaches ACP during generation with ${measured ? 'provider counts' : 'estimated output'}`, { timeout: 20000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'codebuddy-live-speed-'));
    let ended = false;
    let streamOptions;
    const server = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      if (req.url === '/tokenize') { res.end(JSON.stringify({ count: 200, max_model_len: 32768 })); return; }
      streamOptions = JSON.parse(body).stream_options;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = obj => res.write(`data: ${JSON.stringify({ id: 'live', ...obj })}\n\n`);
      for (let i = 1; i <= 8; i++) {
        send({ choices: [{ index: 0, delta: { content: 'word '.repeat(8) }, finish_reason: null }],
          ...(measured ? { usage: { prompt_tokens: 100, completion_tokens: i * 20, total_tokens: 100 + i * 20 } } : {}) });
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      ended = true;
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      send({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 160, total_tokens: 260 } });
      res.end('data: [DONE]\n\n');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const driver = await createHarnessDriver({ cwd: root, dataDir: join(root, 'state') });
    t.after(async () => { await driver.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const { sessionId } = await driver.createSession({ cwd: root, model: 'fixture', provider: {
      id: 'speed', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, protocol: 'openai-completions', apiKey: 'fixture',
      ...(measured ? { countBackend: 'vllm' } : {}),
    } });
    const project = contextUpdates({ sessionId });
    const samples = [];
    await driver.prompt(sessionId, 'Reply briefly.', { onEvent(event) {
      for (const update of project(event)) {
        const data = zGooseSessionNotification_unstable.parse({ sessionId, update }).update.status?.data;
        if (data && 'liveSpeed' in data) samples.push({ speed: data.liveSpeed, ended });
      }
    } });
    assert.equal(streamOptions.continuous_usage_stats, measured ? true : undefined);
    assert.ok(samples.some(({ speed, ended }) => !ended && speed?.estimated === !measured && speed.rate > 0 &&
      (!measured || (speed.rate > 60 && speed.rate < 140))), JSON.stringify(samples));
    assert.equal(samples.at(-1).speed, null);
  });
}

test('cache receipts preserve explicit zero, absence and provider aliases across requests and reload', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-cache-receipts-'));
  const cases = [
    { fields: { prompt_tokens_details: { cached_tokens: 820 } }, expected: 820 },
    { fields: { prompt_tokens_details: { cached_tokens: 0 } }, expected: 0 },
    { fields: {}, expected: undefined },
    { fields: { prompt_cache_hit_tokens: 0 }, expected: 0 },
    { fields: { cached_tokens: 0 }, expected: 0 },
    { fields: { prompt_tokens_details: { cached_tokens: null } }, expected: undefined },
  ];
  let index = 0;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    assert.equal(JSON.parse(body).stream_options.include_usage, true);
    const usage = { prompt_tokens: 1000, completion_tokens: 2, total_tokens: 1002, ...cases[index++].fields };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'cache', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'cache', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    // vLLM puts final usage on a separate chunk with no choices.
    res.end(`data: ${JSON.stringify({ id: 'cache', choices: [], usage })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let driver;
  try {
    const options = { dataDir: join(root, 'state'), cwd: root };
    driver = await createHarnessDriver(options);
    const { sessionId } = await driver.createSession({ cwd: root, model: 'fixture',
      provider: { id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, protocol: 'openai-completions', apiKey: 'fixture' } });
    for (const item of cases) {
      const events = [];
      await driver.prompt(sessionId, 'Reply OK without tools.', { onEvent: e => events.push(e) });
      const receipt = events.find(e => e.type === 'usage');
      assert.ok(receipt);
      assert.equal(receipt.cacheReadTokens, item.expected);
      assert.equal(Object.hasOwn(receipt, 'cacheReadTokens'), item.expected !== undefined);
      assert.equal(receipt.totalTokens, 1002);
    }
    const history = await driver.history(sessionId);
    const receipts = history.events.filter(e => e.type === 'assistant/message' && e.data.usage).map(e => e.data.usage);
    assert.equal(receipts.length, cases.length);
    assert.deepEqual(receipts.map(u => u.cacheReadTokens), cases.map(c => c.expected));
    await driver.close();
    driver = await createHarnessDriver(options);
    const replay = await driver.history(sessionId);
    assert.deepEqual(replay.events.filter(e => e.type === 'assistant/message' && e.data.usage).map(e => e.data.usage), receipts);
  } finally {
    await driver?.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('official sessionStats survives reload and reaches ACP without counting idle time', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-composer-stats-'));
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta, finish_reason = null, usage) => res.write(`data: ${JSON.stringify({
      id: 'stats', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
    })}\n\n`);
    emit({ role: 'assistant', content: 'Controlled ' });
    await new Promise(resolve => setTimeout(resolve, 80));
    emit({ content: 'response.' });
    emit({}, 'stop', { prompt_tokens: 1000, completion_tokens: 40, total_tokens: 1040,
      prompt_tokens_details: { cached_tokens: 820 } });
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let driver;
  try {
    const options = { dataDir: join(root, 'state'), cwd: root };
    driver = await createHarnessDriver(options);
    const { sessionId } = await driver.createSession({ cwd: root, model: 'fixture',
      provider: { id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, protocol: 'openai-completions', apiKey: 'fixture' } });
    const empty = await driver.contextUsage(sessionId);
    assert.equal(empty.sessionStats.decodeTokens, 0);
    const events = [];
    await driver.prompt(sessionId, 'Respond with plain text only.', { onEvent: e => events.push(e) });
    const meter = await driver.contextUsage(sessionId);
    assert.equal(meter.sessionStats.decodeTokens, 40);
    assert.ok(meter.sessionStats.decodeMs >= 50);
    const receipt = events.find(e => e.type === 'usage');
    assert.equal(receipt.cacheReadTokens, 820);
    assert.equal(receipt.inputTokens + receipt.cacheReadTokens, 1000);
    const update = contextUpdates({ sessionId })(meter).find(u => u.sessionUpdate === 'status_message');
    assert.deepEqual(update.status.data.sessionStats, meter.sessionStats);
    const decoded = zGooseSessionNotification_unstable.parse({ sessionId, update });
    assert.deepEqual(decoded.update.status.data.sessionStats, meter.sessionStats);
    assert.equal(contextUpdates({ sessionId: 'other' })(meter).length, 0);
    await driver.close();
    await new Promise(resolve => setTimeout(resolve, 120));
    driver = await createHarnessDriver(options);
    const replay = await driver.contextUsage(sessionId);
    assert.deepEqual(replay.sessionStats, meter.sessionStats);
  } finally {
    await driver?.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
