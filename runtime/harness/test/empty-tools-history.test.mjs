import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessDriver } from '../index.mjs';
import { replyToNoActionReview } from './review-fixture.mjs';

for (const legacy of [undefined, false, true]) test(`revoked tools stay revoked across summary and restore; legacy empty-tools compatibility=${legacy}`, { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cb-empty-tool-history-'));
  const requests = [], measurements = [];
  let calls = 0, effects = 0, driver;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    if (req.url === '/tokenize') {
      measurements.push(body);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ count: 1000, max_model_len: 65536 }));
      return;
    }
    if (replyToNoActionReview(body, res)) return;
    const summary = JSON.stringify(body.messages.at(-1)).includes('You are now acting as a compaction engine');
    requests.push({ body, summary });
    const hasHistory = body.messages.some(m => m.role === 'tool' || m.tool_calls?.length);
    if (calls > 1 && !summary && (legacy === true && hasHistory ? !Array.isArray(body.tools) : Array.isArray(body.tools) && body.tools.length === 0)) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Invalid tool-history compatibility envelope', type: 'invalid_request_error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'empty-tools', model: body.model,
      choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    if (!summary && calls++ === 0) {
      emit({ tool_calls: [{ index: 0, id: 'effect-once', type: 'function', function: { name: 'fixture_effect', arguments: '{}' } }] });
      emit({}, 'tool_calls');
    } else {
      emit({ content: summary ? 'Keep ORION-739; effect completed exactly once; do not repeat it.' : 'ORION-739 completed evidence. '.repeat(300) });
      emit({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await driver?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const provider = { id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, protocol: 'openai-completions',
    contextWindow: 65536, countBackend: 'vllm', retryPolicy: { mode: 'normal', maxRetries: 0 },
    ...(legacy === undefined ? {} : { compat: { requiresToolsWithToolHistory: legacy } }) };
  const options = { maxTokens: 256, autoCompact: false, tools: [{ name: 'fixture_effect', description: 'One isolated file effect',
    parameters: { type: 'object', properties: {} }, async execute() {
      effects++; await writeFile(join(root, 'once.txt'), 'Completed exactly once'); return { receipt: 'effect-once' };
    } }] };
  driver = await createHarnessDriver({ dataDir: join(root, 'data'), cwd: root });
  const { sessionId } = await driver.createSession({ cwd: root, provider, model: 'fixture', options });
  await driver.prompt(sessionId, 'Record ORION-739 and execute the isolated effect once.', { onPermission: () => true });
  assert.equal(effects, 1);
  const before = await driver.history(sessionId);
  await driver.configureSession(sessionId, { tools: [], toolFilter: { allow: [] } });
  await driver.prompt(sessionId, 'Continue without tools. Keep the completed evidence.');
  const continued = requests.at(-1).body;
  assert.ok(continued.messages.some(m => m.role === 'tool'), 'completed tool evidence must remain in the transcript');
  assert.equal(Object.hasOwn(continued, 'tools'), legacy === true);
  if (legacy) assert.deepEqual(continued.tools, []);
  await driver.compact(sessionId);
  assert.ok(requests.some(r => r.summary));
  for (const request of requests.slice(2)) {
    const hasHistory = request.body.messages.some(m => m.role === 'tool' || m.tool_calls?.length);
    assert.equal(Object.hasOwn(request.body, 'tools'), legacy === true && hasHistory, 'summary and chat use the same compatibility rule');
    if (request.body.tools) assert.deepEqual(request.body.tools, [], 'never resurrect a revoked schema');
    const measured = measurements.findLast(m => JSON.stringify(m.messages) === JSON.stringify(request.body.messages));
    assert.ok(measured, 'the exact sent history was counted by the native request-fit serializer');
    assert.equal(Object.hasOwn(measured, 'tools'), Object.hasOwn(request.body, 'tools'));
    assert.deepEqual(measured.tools, request.body.tools);
  }
  const compacted = await driver.history(sessionId);
  assert.deepEqual(compacted.events.slice(0, before.events.length), before.events);
  await driver.close();
  driver = await createHarnessDriver({ dataDir: join(root, 'data'), cwd: root });
  await driver.createSession({ sessionId, cwd: root, provider, model: 'fixture', options: { ...options, tools: [], toolFilter: { allow: [] } } });
  await driver.prompt(sessionId, 'Continue from the preserved checkpoint, without tools.');
  assert.equal(effects, 1);
  assert.equal(await readFile(join(root, 'once.txt'), 'utf8'), 'Completed exactly once');
  const restored = await driver.history(sessionId);
  assert.deepEqual(restored.events.slice(0, compacted.events.length), compacted.events);
  assert.equal(restored.events.filter(e => e.type === 'tool/call').length, 1);
});
