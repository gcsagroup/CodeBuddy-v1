import { replyToNoActionReview } from './review-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../sdk-budget-contract.mjs';
import { createHarnessDriver } from '../index.mjs';

const { Session } = await import('@deepseek-ai/dsh-session');

const WARM_HISTORY = 'Recorded fixture facts with a completed receipt. '.repeat(350);
const FINAL = 'FINAL_AFTER_REQUEST_FIT_RECOVERY';

function reply(res, content, { finish = 'stop', output = 20, tool, usage = { prompt_tokens: 500, completion_tokens: output, total_tokens: 500 + output } } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
    id: 'request-fit-fixture', object: 'chat.completion.chunk', model: 'fixture',
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`);
  if (content) emit({ content });
  if (tool) emit({ tool_calls: [{ index: 0, id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments ?? '{}' } }] });
  emit({}, tool && finish === 'stop' ? 'tool_calls' : finish);
  if (usage !== null) res.write(`data: ${JSON.stringify({ id: 'request-fit-fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [], usage })}\n\n`);
  res.end('data: [DONE]\n\n');
}

async function fixture(t, handler, { contextWindow = 65536, maxTokens = 256, useDefaultBudget = false, defaultPressure = false, protocol = 'openai-completions', retryPolicy, tools, outputTokenCapacity, requestMaxTokens, count } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'harness-request-fit-'));
  const requests = [];
  const f = { requests, root };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    if (req.url === '/tokenize' && count) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      count: count(body), max_model_len: contextWindow,
    }));
    if (replyToNoActionReview(body, res)) return;
    const lastContent = (body.messages ?? body.input)?.at(-1)?.content;
    const lastText = typeof lastContent === 'string' ? lastContent : (lastContent ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
    // This fixture identifies the SDK's auxiliary directive only to choose a
    // mock response. It must still recognize a summary whose cap was clamped.
    const request = { body, summary: lastText.startsWith('You are now acting as a compaction engine for this AI coding assistant.') };
    requests.push(request);
    await handler(request, res, requests);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = { id: 'fixture', ...(count ? { countBackend: 'vllm' } : {}), baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-only', contextWindow, protocol, ...(outputTokenCapacity ? { outputTokenCapacity } : {}), ...(requestMaxTokens === undefined ? {} : { requestMaxTokens }), ...(retryPolicy ? { retryPolicy } : {}) };
  f.provider = provider;
  const options = { ...useDefaultBudget ? {} : { maxTokens }, ...(defaultPressure ? {} : { autoCompactThreshold: 0.99 }), ...(tools ? { tools } : {}) };
  f.options = options;
  const open = async () => {
    f.driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd: root });
    const session = await f.driver.createSession({ ...(f.sessionId ? { sessionId: f.sessionId } : {}), cwd: root, provider, model: 'fixture', options });
    f.sessionId = session.sessionId;
  };
  t.after(async () => { await f.driver?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await open();
  f.createSibling = async () => (await f.driver.createSession({ cwd: root, provider, model: 'fixture', options })).sessionId;
  f.reopen = async () => { await f.driver.close(); await open(); };
  f.configure = () => f.driver.createSession({ sessionId: f.sessionId, cwd: root, provider, model: 'fixture', options });
  return f;
}

const failures = history => history.events
  .filter(event => event.type === 'assistant/attempt')
  .flatMap(event => event.data.stream)
  .filter(record => record.type === 'chunk' && record.chunk.type === 'finish')
  .map(record => record.chunk.reason.failure)
  .filter(Boolean);
const summaries = history => history.events.filter(event => event.type === 'compaction/summary');

for (const mode of ['empty', 'length', 'bad-request', 'not-found', 'not-smaller', 'preparation']) test(`three-stage compaction reaches Flash after injected ${mode} failures`, { timeout: 20000 }, async t => {
  const f = await fixture(t, (request, res) => {
    if (!request.summary) return reply(res, WARM_HISTORY);
    if (request.body.model === 'fixture') {
      if (mode === 'bad-request' || mode === 'not-found') return res.writeHead(mode === 'bad-request' ? 400 : 404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Injected missing model', type: 'invalid_request_error' } }));
      return reply(res, mode === 'not-smaller' ? JSON.stringify(request.body.messages) : '');
    }
    if (request.body.model === 'user-backup') {
      if (mode === 'length') return reply(res, 'Incomplete.', { finish: 'length', output: 20 });
      return reply(res, mode === 'not-smaller' ? JSON.stringify(request.body.messages) : '');
    }
    reply(res, 'Keep ORION-739; corrected tax is 750 bps; do not publish.');
  });
  await warm(f);
  const before = await f.driver.history(f.sessionId);
  f.options.compactionFallbacks = [{ source: { provider: f.provider, model: 'fixture' }, fallbacks: [
    mode === 'preparation' ? { resolveFallback: async () => { throw Error('Injected connection setup failure'); } }
      : { fallback: { provider: { ...f.provider, id: 'user-backup', contextWindow: 196608 }, model: 'user-backup' } },
    { fallback: { provider: { ...f.provider, id: 'fixed-flash', contextWindow: 196608 }, model: 'flash' } },
  ] }];
  await f.configure();
  await f.driver.compact(f.sessionId);
  const after = await f.driver.history(f.sessionId);
  assert.deepEqual(after.events.slice(0, before.events.length), before.events);
  assert.equal(summaries(after).length, 1);
  assert.equal(summaries(after)[0].data.model, 'flash');
  assert.deepEqual(f.requests.filter(r => r.summary).map(r => r.body.model), mode === 'preparation'
    ? ['fixture', 'flash'] : ['fixture', 'user-backup', 'flash']);
  await f.driver.prompt(f.sessionId, 'Continue using the preserved constraints.');
  assert.equal(f.requests.at(-1).body.model, 'fixture', 'fallback never changes the chat model');
});

test('all three failures preserve work and a later explicit retry recovers without replaying tools', { timeout: 20000 }, async t => {
  let online = false, calls = 0, effects = 0;
  const f = await fixture(t, (request, res) => {
    if (request.summary) return reply(res, online && request.body.model === 'flash' ? 'Keep ORION-739; corrected tax 750 bps; do not publish.' : '');
    if (++calls === 2) return reply(res, '', { tool: { id: 'completed-write', name: 'fixture_write' } });
    reply(res, WARM_HISTORY);
  }, { tools: [{ name: 'fixture_write', description: 'Write one file in the isolated fixture', parameters: { type: 'object', properties: {} },
    async execute() { effects++; await writeFile(join(f.root, 'completed.txt'), 'Completed exactly once'); return { receipt: 'FILE_WRITTEN_ONCE' }; } }] });
  await warm(f);
  await f.driver.prompt(f.sessionId, 'Complete the isolated write once.', { onPermission: () => true });
  f.options.compactionFallbacks = [{ source: { provider: f.provider, model: 'fixture' }, fallbacks: [
    { fallback: { provider: { ...f.provider, id: 'user', contextWindow: 196608 }, model: 'user-backup' } },
    { fallback: { provider: { ...f.provider, id: 'fixed', contextWindow: 196608 }, model: 'flash' } },
  ] }];
  await f.configure();
  const before = await f.driver.history(f.sessionId);
  await assert.rejects(f.driver.compact(f.sessionId));
  const failed = await f.driver.history(f.sessionId);
  assert.deepEqual(failed.events.slice(0, before.events.length), before.events);
  assert.equal(summaries(failed).length, 0);
  assert.equal(await readFile(join(f.root, 'completed.txt'), 'utf8'), 'Completed exactly once');
  assert.deepEqual(f.requests.filter(r => r.summary).map(r => r.body.model), ['fixture', 'user-backup', 'flash']);
  assert.equal((await f.driver.prompt(f.sessionId, 'Continue using the retained context while it still fits.', { onPermission: () => true })).stopReason, 'end_turn');
  assert.equal(effects, 1, 'a failed manual compaction does not make a still-fitting conversation unusable');
  online = true;
  await f.reopen();
  await f.driver.compact(f.sessionId);
  const after = await f.driver.history(f.sessionId);
  assert.equal(summaries(after).at(-1).data.model, 'flash');
  await f.driver.prompt(f.sessionId, 'Continue after restoring compression.', { onPermission: () => true });
  assert.equal(effects, 1);
  assert.equal(after.events.filter(e => e.type === 'tool/call').length, 1);
  assert.equal(await readFile(join(f.root, 'completed.txt'), 'utf8'), 'Completed exactly once');
});

test('automatic compaction follows the same three-stage failure order', { timeout: 20000 }, async t => {
  const f = await fixture(t, (request, res) => reply(res, !request.summary ? WARM_HISTORY
    : request.body.model === 'flash' ? 'Keep ORION-739; corrected tax 750 bps; do not publish.' : ''));
  await warm(f);
  f.options.autoCompactThreshold = 0.05;
  f.options.compactionFallbacks = [{ source: { provider: f.provider, model: 'fixture' }, fallbacks: [
    { fallback: { provider: { ...f.provider, id: 'user', contextWindow: 196608 }, model: 'user-backup' } },
    { fallback: { provider: { ...f.provider, id: 'fixed', contextWindow: 196608 }, model: 'flash' } },
  ] }];
  await f.configure();
  await f.driver.prompt(f.sessionId, 'Continue with verification.');
  assert.deepEqual(f.requests.filter(r => r.summary).slice(0, 3).map(r => r.body.model), ['fixture', 'user-backup', 'flash']);
  assert.equal(summaries(await f.driver.history(f.sessionId)).at(-1).data.model, 'flash');
});

test('repeated fallback connections are dispatched at most once after a failed checkpoint', { timeout: 15000 }, async t => {
  const f = await fixture(t, (request, res) => reply(res, request.summary ? '' : WARM_HISTORY));
  await warm(f);
  const flash = { fallback: { provider: { ...f.provider, id: 'fixed', contextWindow: 196608 }, model: 'flash' } };
  f.options.compactionFallbacks = [{ source: { provider: f.provider, model: 'fixture' }, fallbacks: [flash, flash] }];
  await f.configure();
  await assert.rejects(f.driver.compact(f.sessionId));
  assert.deepEqual(f.requests.filter(r => r.summary).map(r => r.body.model), ['fixture', 'flash']);
});

test('fallback compacts an oversized wide-model history for the destination window before manual success', { timeout: 30000 }, async t => {
  const count = body => Math.ceil(JSON.stringify(body.messages).length / 4);
  const f = await fixture(t, (request, res) => reply(res, request.summary
    ? 'ORION-739; corrected tax 750 bps; currency CNY, integer cents; verify next; publishing forbidden.' : 'Received.'),
  { contextWindow: 524288, useDefaultBudget: true, count });
  for (let i = 0; i < 8; i++) await f.driver.prompt(f.sessionId, `Completed archive ${i}. ` + 'Synthetic completed archive record. '.repeat(2850));
  await f.driver.prompt(f.sessionId, 'Keep the corrected 750 bps and wait.');
  const before = await f.driver.history(f.sessionId);
  const gemma = { ...f.provider, id: 'destination', contextWindow: 65536 };
  const qwen = { ...f.provider, id: 'fallback', contextWindow: 196608 };
  f.options.compactionFallbacks = [{ source: { provider: gemma, model: 'gemma' }, fallback: { provider: qwen, model: 'qwen' } }];
  await f.driver.createSession({ sessionId: f.sessionId, cwd: f.root, provider: gemma, model: 'gemma', options: f.options });
  const normalCount = f.requests.filter(r => !r.summary).length;
  await f.driver.compact(f.sessionId);
  const after = await f.driver.history(f.sessionId);
  assert.deepEqual(after.events.slice(0, before.events.length), before.events);
  assert.ok(summaries(after).length > 1, 'Qwen capacity is not the destination success condition');
  assert.ok(summaries(after).every(event => event.data.model === 'qwen'));
  assert.equal(f.requests.filter(r => !r.summary).length, normalCount, 'destination fit must not generate a probe reply');
  assert.ok(f.requests.filter(r => r.summary).every(r => r.body.model === 'qwen'), 'oversized Gemma summaries fail locally before HTTP');
  const { events } = after;
  const restored = new Session(after.meta.id, events, after.meta, 'snapshot', after.inheritedEventCount);
  const priced = count({ messages: restored.deriveMessages() });
  assert.ok(priced < 65536 - 4096 - 1024);
  const committed = summaries(after).length;
  await f.driver.prompt(f.sessionId, 'Return the preserved tax rate.');
  assert.equal(f.requests.at(-1).body.model, 'gemma');
  assert.equal(summaries(await f.driver.history(f.sessionId)).length, committed, 'the first destination reply must not need another compaction');
});

test('failed Qwen fallback preserves history, does not loop, and explicit retry can recover', { timeout: 15000 }, async t => {
  let mode = 'both-empty';
  const f = await fixture(t, (request, res) => reply(res, request.summary
    ? request.body.model === 'qwen' && mode === 'recovered' ? 'Keep ORION-739; use 750 bps; do not publish.' : '' : WARM_HISTORY));
  await warm(f);
  const before = await f.driver.history(f.sessionId);
  const fallback = { ...f.provider, id: 'qwen-fallback', contextWindow: 196608 };
  f.options.compactionFallbacks = [{ source: { provider: f.provider, model: 'fixture' }, fallback: { provider: fallback, model: 'qwen' } }];
  await f.configure();
  await assert.rejects(f.driver.compact(f.sessionId), error => error.cause?.code === 'EMPTY_RESPONSE');
  const failed = await f.driver.history(f.sessionId);
  assert.equal(summaries(failed).length, 0);
  assert.deepEqual(failed.events.slice(0, before.events.length), before.events);
  assert.deepEqual(f.requests.filter(r => r.summary).map(r => r.body.model), ['fixture', 'qwen']);
  mode = 'recovered';
  await f.driver.compact(f.sessionId);
  assert.equal(summaries(await f.driver.history(f.sessionId)).at(-1).data.model, 'qwen');
});

test('manual cancellation does not dispatch the configured fallback', { timeout: 15000 }, async t => {
  const abort = new AbortController();
  const f = await fixture(t, (request, res) => {
    if (!request.summary) return reply(res, WARM_HISTORY);
    setTimeout(() => abort.abort(Error('Explicit test cancellation')), 20);
  });
  await warm(f);
  f.options.compactionFallbacks = [{ source: { provider: f.provider, model: 'fixture' },
    fallback: { provider: { ...f.provider, id: 'unused-fallback' }, model: 'qwen' } }];
  await f.configure();
  await assert.rejects(f.driver.compact(f.sessionId, { signal: abort.signal }));
  assert.deepEqual(f.requests.filter(r => r.summary).map(r => r.body.model), ['fixture']);
  assert.equal(summaries(await f.driver.history(f.sessionId)).length, 0);
});

test('native non-shrinking summary validation can activate the fallback without committing the rejected summary', { timeout: 15000 }, async t => {
  const f = await fixture(t, (request, res) => reply(res, !request.summary ? WARM_HISTORY
    : request.body.model === 'fixture' ? JSON.stringify(request.body.messages) : 'Keep ORION-739; corrected tax is 750 bps; do not publish.'));
  await warm(f);
  f.options.compactionFallbacks = [{ source: { provider: f.provider, model: 'fixture' },
    fallback: { provider: { ...f.provider, id: 'qwen' }, model: 'qwen' } }];
  await f.configure();
  await f.driver.compact(f.sessionId);
  const history = await f.driver.history(f.sessionId);
  assert.equal(summaries(history).length, 1);
  assert.equal(summaries(history)[0].data.model, 'qwen');
  assert.equal(history.events.filter(e => e.type === 'compaction/end' && e.data.error).length, 1);
  assert.deepEqual(f.requests.filter(r => r.summary).map(r => r.body.model), ['fixture', 'qwen']);
});

test('a provider length stop before its advertised budget still activates summary fallback', { timeout: 15000 }, async t => {
  const f = await fixture(t, (request, res) => {
    if (!request.summary) return reply(res, WARM_HISTORY);
    if (request.body.model === 'fixture') return reply(res, 'Incomplete checkpoint.', { finish: 'length', output: 20 });
    reply(res, 'Keep ORION-739; corrected tax is 750 bps; do not publish.');
  });
  await warm(f);
  f.options.compactionFallbacks = [{ source: { provider: f.provider, model: 'fixture' },
    fallback: { provider: { ...f.provider, id: 'qwen' }, model: 'qwen' } }];
  await f.configure();
  await f.driver.compact(f.sessionId);
  assert.equal(summaries(await f.driver.history(f.sessionId)).at(-1).data.model, 'qwen');
  assert.deepEqual(f.requests.filter(r => r.summary).map(r => r.body.model), ['fixture', 'qwen']);
});

test('cancellation during lazy fallback preparation never dispatches a Qwen request', { timeout: 15000 }, async t => {
  const requested = Promise.withResolvers(), prepared = Promise.withResolvers(), abort = new AbortController();
  const f = await fixture(t, (request, res) => reply(res, request.summary ? '' : WARM_HISTORY));
  await warm(f);
  f.options.compactionFallbacks = [{ source: { provider: f.provider, model: 'fixture' },
    resolveFallback() { requested.resolve(); return prepared.promise; } }];
  await f.configure();
  const compacting = f.driver.compact(f.sessionId, { signal: abort.signal });
  const rejected = assert.rejects(compacting);
  await requested.promise;
  abort.abort(Error('Explicit cancellation during connection preparation'));
  await rejected;
  prepared.resolve({ provider: { ...f.provider, id: 'qwen' }, model: 'qwen' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.requests.filter(r => r.summary).map(r => r.body.model), ['fixture']);
  assert.equal(summaries(await f.driver.history(f.sessionId)).length, 0);
});

test('truncated fallback output is rejected and a too-large protected user message stays intact', { timeout: 20000 }, async t => {
  let mode = 'truncated';
  const f = await fixture(t, (request, res) => {
    if (!request.summary) return reply(res, WARM_HISTORY);
    if (request.body.model === 'fixture') return reply(res, '');
    reply(res, 'ORION-739; 750 bps; do not publish.', mode === 'truncated'
      ? { finish: 'length', output: request.body.max_completion_tokens ?? request.body.max_tokens } : {});
  }, { contextWindow: 524288, useDefaultBudget: true });
  await warm(f);
  f.options.compactionFallbacks = [{ source: { provider: f.provider, model: 'fixture' },
    fallback: { provider: { ...f.provider, id: 'qwen' }, model: 'qwen' } }];
  await f.configure();
  await assert.rejects(f.driver.compact(f.sessionId), error => error.cause?.code === 'MAX_TOKENS');
  assert.equal(summaries(await f.driver.history(f.sessionId)).length, 0, 'partial Qwen output must not become a checkpoint');
  mode = 'valid';
  await f.driver.prompt(f.sessionId, 'Protected latest request: ' + 'Preserve this exact human content. '.repeat(6500));
  const before = await f.driver.history(f.sessionId);
  const protectedUser = before.events.findLast(event => event.type === 'user/message' && event.data.content?.some(block => block.text?.startsWith('Protected latest request:')));
  const gemma = { ...f.provider, contextWindow: 16384 };
  f.options.compactionFallbacks = [{ source: { provider: gemma, model: 'fixture' },
    fallback: { provider: { ...f.provider, id: 'qwen' }, model: 'qwen' } }];
  await f.driver.createSession({ sessionId: f.sessionId, cwd: f.root, provider: gemma, model: 'fixture', options: f.options });
  await assert.rejects(f.driver.compact(f.sessionId));
  const after = await f.driver.history(f.sessionId);
  assert.deepEqual(after.events.slice(0, before.events.length), before.events);
  assert.ok(protectedUser);
  const restored = new Session(after.meta.id, after.events, after.meta, 'snapshot', after.inheritedEventCount);
  assert.deepEqual(restored.deriveMessages().find(message => message.id === protectedUser.data.id), protectedUser.data);
});

test('manual compaction retries one truncated checkpoint, preserves failed history and can retry explicitly', { timeout: 20000 }, async t => {
  let mode = 'truncate-once', summaryCalls = 0;
  const f = await fixture(t, (request, res) => {
    if (!request.summary) return reply(res, WARM_HISTORY);
    summaryCalls++;
    if (mode === 'empty') return reply(res, '');
    if (mode === 'truncate-once' && summaryCalls === 1) return reply(res, 'Incomplete checkpoint', { finish: 'length', output: request.body.max_completion_tokens ?? request.body.max_tokens });
    return reply(res, 'Recorded fixture facts. Preserve integer cents.');
  });
  await warm(f);
  await f.driver.compact(f.sessionId);
  assert.equal(summaryCalls, 2);
  assert.deepEqual(f.requests.filter(r => r.summary).map(r => r.body.max_completion_tokens ?? r.body.max_tokens), [16384, 32768]);
  const good = await f.driver.history(f.sessionId);
  assert.equal(summaries(good).length, 1, 'truncated output must never become a checkpoint');
  await f.driver.prompt(f.sessionId, 'Continue with additional recorded facts.');
  mode = 'empty';
  const before = await f.driver.history(f.sessionId);
  await assert.rejects(f.driver.compact(f.sessionId), error => error.cause?.code === 'EMPTY_RESPONSE');
  const failed = await f.driver.history(f.sessionId);
  assert.equal(summaries(failed).length, summaries(before).length);
  assert.deepEqual(failed.events.slice(0, before.events.length), before.events);
  await f.reopen();
  mode = 'success';
  await f.driver.compact(f.sessionId);
  assert.equal(summaries(await f.driver.history(f.sessionId)).length, 2);
});

test('default summary output reaches 32768 on large windows and scales down on small windows', { timeout: 30000 }, async t => {
  for (const [contextWindow, expected] of [[32768, 8192], [65536, 16384], [131072, 32768], [262144, 32768]]) {
    const f = await fixture(t, (request, res) => reply(res, request.summary
      ? 'Keep the verified fixture facts and the pending user requirement.' : WARM_HISTORY), { contextWindow });
    await warm(f);
    await f.driver.compact(f.sessionId);
    const summaryRequests = f.requests.filter(request => request.summary);
    assert.equal(summaryRequests.length, 1);
    assert.equal(summaryRequests[0].body.max_completion_tokens ?? summaryRequests[0].body.max_tokens, expected);
    assert.equal(summaries(await f.driver.history(f.sessionId)).length, 1);
  }
});

test('switching a connection or model then compacting immediately uses the live selection, including after restart', { timeout: 30000 }, async t => {
  for (const cold of [false, true]) for (const model of ['fixture', 'other-model']) {
    const f = await fixture(t, (request, res) => reply(res, request.summary
      ? 'Preserve ORION-739 and integer cents. Continue with verification.' : WARM_HISTORY));
    await f.driver.prompt(f.sessionId, 'Remember ORION-739 and integer cents.');
    const original = await f.driver.history(f.sessionId);
    const oldHeader = original.events.findLast(event => event.type === 'request/header');
    // Register only the replacement connection in the restarted Host. Keeping
    // the old adapter live would hide the reported NO_ADAPTER failure.
    f.provider.id = 'replacement-connection';
    f.provider.contextWindow = 32768;
    if (cold) await f.reopen();
    await f.driver.createSession({ sessionId: f.sessionId, cwd: f.root, provider: f.provider, model });
    const selected = (await f.driver.history(f.sessionId)).events.findLast(event => event.type === 'model/selection').data;
    assert.notEqual(selected.provider, oldHeader.data.header.config.provider);
    const sent = f.requests.length;
    assert.ok(await f.driver.compact(f.sessionId));
    const after = await f.driver.history(f.sessionId);
    assert.deepEqual(f.requests.slice(sent).map(request => [request.summary, request.body.model]), [[true, model]],
      'manual maintenance sends only the summary, with no preliminary chat request');
    const checkpoint = summaries(after).at(-1);
    assert.deepEqual([checkpoint.data.provider, checkpoint.data.model, checkpoint.data.maxTokens], [selected.provider, model, 8192]);
    assert.deepEqual(after.events.slice(0, original.events.length), original.events, 'historical request and work facts remain unchanged');
    assert.deepEqual(after.events.filter(event => event.type === 'request/header'), original.events.filter(event => event.type === 'request/header'));
    assert.equal(after.events.findLast(event => event.type === 'compaction/end').data.error, undefined);
    assert.deepEqual(after.events.findLast(event => event.type === 'model/selection').data, selected,
      'maintenance leaves the selected next chat model intact');
    await f.reopen();
    assert.deepEqual(summaries(await f.driver.history(f.sessionId)), summaries(after), 'the native checkpoint survives a cold reload');
  }
});

test('a failed manual summary preserves history and switching models permits an immediate explicit retry', { timeout: 20000 }, async t => {
  const f = await fixture(t, (request, res) => {
    if (request.summary && request.body.model === 'rejecting-model') return res.writeHead(400, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: { message: 'Unsupported fixture parameter', code: 'invalid_request_error' } }));
    reply(res, request.summary ? 'Preserve ORION-739 and integer cents.' : WARM_HISTORY);
  });
  await warm(f);
  const original = await f.driver.history(f.sessionId);
  const sent = f.requests.length;
  await f.driver.createSession({ sessionId: f.sessionId, cwd: f.root, provider: f.provider, model: 'rejecting-model' });
  await assert.rejects(f.driver.compact(f.sessionId));
  const failed = await f.driver.history(f.sessionId);
  assert.equal(summaries(failed).length, 0);
  assert.deepEqual(failed.events.slice(0, original.events.length), original.events);
  assert.match(failed.events.findLast(event => event.type === 'compaction/end').data.error, /Unsupported fixture parameter/);
  await f.driver.createSession({ sessionId: f.sessionId, cwd: f.root, provider: f.provider, model: 'working-model' });
  assert.ok(await f.driver.compact(f.sessionId));
  const recovered = await f.driver.history(f.sessionId);
  assert.deepEqual(f.requests.slice(sent).map(request => [request.summary, request.body.model]),
    [[true, 'rejecting-model'], [true, 'working-model']]);
  assert.equal(summaries(recovered).length, 1);
  assert.equal(summaries(recovered)[0].data.model, 'working-model');
  assert.deepEqual(recovered.events.filter(event => event.type === 'request/header'), original.events.filter(event => event.type === 'request/header'));
});

test('service capacity, explicit user budget and unknown fallback reach the real HTTP envelope', { timeout: 20000 }, async t => {
  for (const scenario of [
    { outputTokenCapacity: 131072, useDefaultBudget: true, expected: 131072 },
    { outputTokenCapacity: 131072, maxTokens: 2048, expected: 2048 },
    { useDefaultBudget: true, expected: 32768 },
    { maxTokens: 65536, expected: 65536 },
    { requestMaxTokens: 65536, useDefaultBudget: true, expected: 65536 },
    { requestMaxTokens: 1024, outputTokenCapacity: 131072, maxTokens: 2048, expected: 2048 },
  ]) {
    const f = await fixture(t, (_request, res) => reply(res, FINAL), { contextWindow: 524288, ...scenario });
    assert.equal((await f.driver.prompt(f.sessionId, 'Return the fixture result.')).stopReason, 'end_turn');
    assert.equal(f.requests[0].body.max_completion_tokens ?? f.requests[0].body.max_tokens, scenario.expected);
  }
  const invalid = await fixture(t, (_request, res) => reply(res, 'UNEXPECTED'), {
    contextWindow: 524288, outputTokenCapacity: 131072, maxTokens: 200000,
  });
  await assert.rejects(invalid.driver.prompt(invalid.sessionId, 'Return the fixture result.'), { code: 'INVALID_OUTPUT_BUDGET' });
  assert.equal(invalid.requests.length, 0);
});

test('a configured output budget reaches children and cold-restored sessions without changing route identity', { timeout: 20000 }, async t => {
  let childId, parentCalls = 0, childCalls = 0, continued = false, continuationCalls = 0;
  const f = await fixture(t, (request, res) => {
    const child = request.body.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('Your parent agent id is'));
    if (child) { childCalls++; return reply(res, 'CONFIRMED_CHILD_RESULT'); }
    if (continued && continuationCalls++ === 0) return reply(res, '', { tool: { id: 'continue-budget-child', name: 'send_message',
      arguments: JSON.stringify({ agent_id: childId, message: 'Perform a new short check explicitly.' }) } });
    if (parentCalls++ === 0) return reply(res, '', { tool: { id: 'budget-child', name: 'subagent', arguments: JSON.stringify({ role: 'code reviewer', description: 'Verify inherited budget', prompt: 'Return a short isolated result.' }) } });
    reply(res, FINAL);
  }, { useDefaultBudget: true, requestMaxTokens: 2048 });
  await f.driver.prompt(f.sessionId, 'Delegate the isolated check.', { onPermission: () => true,
    onEvent(event) { if (event.type === 'subagent_start') childId = event.childSessionId; } });
  assert.ok(childId);
  assert.ok(f.requests.every(request => (request.body.max_completion_tokens ?? request.body.max_tokens) === 2048));
  const source = (await f.driver.history(childId)).events.find(event => event.type === 'assistant/message').data.message.source;
  const calls = f.requests.length;
  f.provider.requestMaxTokens = 4096;
  await f.reopen();
  assert.equal(f.requests.length, calls);
  continued = true;
  await f.driver.prompt(f.sessionId, 'Ask the same child for one short new check.', { onPermission: () => true });
  assert.equal(childCalls, 2, 'the recorded child actually resumes through the same registered connection');
  assert.ok(f.requests.slice(calls).every(request => (request.body.max_completion_tokens ?? request.body.max_tokens) === 4096));
  const restored = (await f.driver.history(childId)).events.findLast(event => event.type === 'assistant/message').data.message.source;
  assert.equal(restored.provider, source.provider, 'budget metadata does not change the recorded model connection identity');
});

for (const explicit of [undefined, 512]) test(`clearing the configured default in the same session preserves explicit controls (${explicit ?? 'automatic'})`, { timeout: 15000 }, async t => {
  const f = await fixture(t, (_request, res) => reply(res, FINAL), {
    contextWindow: 524288, useDefaultBudget: explicit === undefined, maxTokens: explicit, requestMaxTokens: 4096,
  });
  await f.driver.prompt(f.sessionId, 'Return the first isolated result.');
  assert.equal(f.requests[0].body.max_completion_tokens ?? f.requests[0].body.max_tokens, explicit ?? 4096);
  const before = (await f.driver.history(f.sessionId)).events.findLast(event => event.type === 'request/header').data.header;
  assert.equal(before.adapterDefaults?.maxTokens, explicit === undefined ? true : undefined);
  delete f.provider.requestMaxTokens;
  await f.configure();
  await f.driver.prompt(f.sessionId, 'Return a second isolated result after clearing the default.');
  assert.equal(f.requests[1].body.max_completion_tokens ?? f.requests[1].body.max_tokens, explicit ?? 32768);
  const after = (await f.driver.history(f.sessionId)).events.findLast(event => event.type === 'request/header').data.header;
  assert.equal(after.config.maxTokens, explicit);
});

test('a child explicit budget takes precedence over its parent explicit budget and model default', { timeout: 20000 }, async t => {
  const { SubagentRuntime } = await import('@deepseek-ai/dsh-subagent');
  const startActivation = SubagentRuntime.prototype.startActivation;
  // This is a trusted native delegation option, not an unsupported model-facing
  // tool argument. The actual native child and HTTP envelope remain unchanged.
  t.mock.method(SubagentRuntime.prototype, 'startActivation', function(spec) {
    return startActivation.call(this, { ...spec, request: { ...spec.request,
      agentOptions: { ...spec.request.agentOptions, maxTokens: 512 } } });
  });
  let parentCalls = 0;
  const f = await fixture(t, (request, res) => {
    const child = request.body.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('Your parent agent id is'));
    if (child) return reply(res, 'CONFIRMED_CHILD_RESULT');
    if (parentCalls++ === 0) return reply(res, '', { tool: { id: 'explicit-child-budget', name: 'subagent', arguments: JSON.stringify({ role: 'code reviewer', description: 'Use an explicit child budget', prompt: 'Return a short result.' }) } });
    reply(res, FINAL);
  }, { maxTokens: 1024, requestMaxTokens: 4096 });
  await f.driver.prompt(f.sessionId, 'Delegate the isolated explicit-budget check.', { onPermission: () => true });
  const childRequests = f.requests.filter(request => request.body.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('Your parent agent id is')));
  assert.equal(childRequests.length, 1);
  assert.equal(childRequests[0].body.max_completion_tokens ?? childRequests[0].body.max_tokens, 512);
  assert.equal(f.requests[0].body.max_completion_tokens ?? f.requests[0].body.max_tokens, 1024);
});

test('full-cap recovery discards partial calls, preserves completed effects and survives reopen without work', { timeout: 20000 }, async t => {
  let effects = 0, checks = 0;
  const f = await fixture(t, (_request, res, requests) => {
    if (requests.length === 1) return reply(res, '', { tool: { id: 'committed-once', name: 'fixture_effect' } });
    if (requests.length === 2) return reply(res, 'FAILED_DRAFT', { finish: 'length', output: 128,
      tool: { id: 'incomplete-call', name: 'fixture_effect', arguments: '{"broken":' } });
    if (requests.length === 3) return reply(res, '', { tool: { id: 'recovered-check', name: 'fixture_check' } });
    reply(res, FINAL);
  }, { maxTokens: 128, tools: [{ name: 'fixture_effect', description: 'Count one isolated effect', parameters: { type: 'object', properties: {} },
    async execute() { effects++; return { receipt: 'COMMITTED_RECEIPT' }; } },
  { name: 'fixture_check', description: 'Read the isolated receipt', parameters: { type: 'object', properties: {} },
    async execute() { checks++; return { receipt: 'CHECKED_RECEIPT' }; } }] });
  const original = 'Perform the effect once and give its receipt.';
  const result = await f.driver.prompt(f.sessionId, original, { onPermission: () => true });
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.outputLimit.automaticAttempts, 1);
  assert.equal(effects, 1);
  assert.equal(checks, 1);
  assert.equal(f.requests.length, 4);
  const recoveryWire = JSON.stringify(f.requests[2].body.messages);
  assert.ok(recoveryWire.includes(original), 'the original human task must reach the retry');
  assert.ok(recoveryWire.includes('using smaller tool calls and shorter file-writing chunks'), 'the recovery instruction must reach HTTP, not just the event log');
  assert.ok(!recoveryWire.includes('FAILED_DRAFT'));
  // Native context keeps earlier snapshots as history and explicitly replaces
  // their authority with the newest full snapshot; it does not erase history.
  const activeRecovery = body => {
    const snapshot = body.messages.findLast(message => message.role === 'user' &&
      typeof message.content === 'string' && message.content.startsWith('Current runtime context.'));
    assert.ok(snapshot, 'a current native context snapshot must reach HTTP');
    return snapshot.content.includes('using smaller tool calls and shorter file-writing chunks');
  };
  assert.equal(activeRecovery(f.requests[0].body), false);
  assert.equal(activeRecovery(f.requests[3].body), false, 'the newest native snapshot must withdraw recovery context after the recovered generation');
  assert.ok(!JSON.stringify(f.requests.at(-1).body.messages).includes('FAILED_DRAFT'));
  assert.ok(f.requests.at(-1).body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'committed-once'));
  const history = await f.driver.history(f.sessionId);
  assert.equal(failures(history).at(-1).code, 'OUTPUT_LIMIT_REACHED');
  assert.equal(history.events.filter(event => event.type === 'plugin:codebuddy/output-recovery').length, 1);
  await f.reopen();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, 4, 'opening recorded history never sends a prompt');
  assert.equal(effects, 1);
  assert.equal((await f.driver.prompt(f.sessionId, 'A separate new user task.')).stopReason, 'end_turn');
  assert.equal(f.requests.length, 5);
  assert.equal(activeRecovery(f.requests.at(-1).body), false, 'new user tasks must not inherit an active recovery instruction');
});

test('full-cap then early truncation cannot obtain a second recovery or compaction', { timeout: 15000 }, async t => {
  const f = await fixture(t, (_request, res, requests) => reply(res, 'INCOMPLETE', { finish: 'length', output: requests.length === 1 ? 128 : 1 }), { maxTokens: 128 });
  const result = await f.driver.prompt(f.sessionId, 'Return the fixture result.');
  assert.equal(result.stopReason, 'max_tokens');
  assert.equal(result.reason.error.code, 'OUTPUT_TRUNCATED');
  assert.equal(result.outputLimit.automaticAttempts, 1);
  assert.equal(f.requests.length, 2);
  assert.equal(summaries(await f.driver.history(f.sessionId)).length, 0);
});

for (const finalLength of [false, true]) test(`later native steps share a two-recovery turn limit (third step truncated: ${finalLength})`, { timeout: 20000 }, async t => {
  let effects = 0;
  const notices = [];
  const f = await fixture(t, (_request, res, requests) => {
    const call = requests.length;
    if (call === 2 || call === 4) return reply(res, '', {
      tool: { id: `confirmed-${call}`, name: 'fixture_effect' },
    });
    reply(res, call === 5 && !finalLength ? FINAL : 'UNCOMMITTED_DRAFT',
      call < 5 || finalLength ? { finish: 'length', output: 128 } : {});
  }, { maxTokens: 128, tools: [{ name: 'fixture_effect', description: 'Count an isolated committed step',
    parameters: { type: 'object', properties: {} },
    async execute() { effects++; return { receipt: `EFFECT_${effects}` }; },
  }] });
  const result = await f.driver.prompt(f.sessionId, 'Complete the two isolated steps and return their receipts.', {
    onPermission: () => true, onEvent(event) { if (event.type === 'output_recovery') notices.push(event); },
  });
  assert.equal(result.stopReason, finalLength ? 'max_tokens' : 'end_turn');
  assert.deepEqual([result.outputLimit.automaticAttempts, result.outputLimit.maxAutomaticAttempts], [2, 2]);
  assert.equal(effects, 2, 'recovery must not replay a previously committed effect');
  assert.equal(f.requests.length, 5, 'no third automatic recovery is dispatched');
  assert.deepEqual(notices.map(event => [event.step, event.attempt]), [[1, 1], [2, 2]]);
  assert.ok(f.requests.every(request => (request.body.max_completion_tokens ?? request.body.max_tokens) === 128));
  assert.ok(f.requests.every(request => request.body.model === 'fixture'));
  const history = await f.driver.history(f.sessionId);
  const records = history.events.filter(event => event.type === 'plugin:codebuddy/output-recovery');
  assert.deepEqual(records.map(event => [event.data.version, event.data.step, event.data.attempt]), [[2, 1, 1], [2, 2, 2]]);
  assert.equal(history.events.filter(event => event.type === 'llm/retry').length, 0);
  await f.reopen();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, 5, 'cold opening history neither refreshes retries nor starts work');
  assert.deepEqual((await f.driver.history(f.sessionId)).events.filter(event => event.type === 'plugin:codebuddy/output-recovery'), records);
});

test('a full-cap recovery and a later compaction share the turn allowance', { timeout: 20000 }, async t => {
  let modelCalls = 0, effects = 0;
  const f = await fixture(t, (request, res) => {
    if (request.summary) return reply(res, 'The previous isolated receipt was confirmed.');
    modelCalls++;
    if (modelCalls === 1) return reply(res, WARM_HISTORY);
    if (modelCalls === 2) return reply(res, 'FULL_CAP_DRAFT', { finish: 'length', output: 256 });
    if (modelCalls === 3) return reply(res, '', { tool: { id: 'confirmed-after-recovery', name: 'fixture_effect' } });
    if (modelCalls === 4) return reply(res, 'EARLY_DRAFT', { finish: 'length', output: 1 });
    reply(res, FINAL);
  }, { tools: [{ name: 'fixture_effect', description: 'Return a real isolated receipt',
    parameters: { type: 'object', properties: {} },
    async execute() { effects++; return { receipt: 'CONFIRMED_ONCE', details: WARM_HISTORY }; },
  }] });
  await warm(f);
  const result = await f.driver.prompt(f.sessionId, 'Continue the isolated task using the recorded facts.', { onPermission: () => true });
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.outputLimit.automaticAttempts, 2);
  assert.equal(effects, 1);
  assert.equal(modelCalls, 5);
  assert.equal(f.requests.filter(request => request.summary).length, 1);
  const history = await f.driver.history(f.sessionId);
  assert.deepEqual(history.events.filter(event => event.type === 'plugin:codebuddy/output-recovery').map(event => event.data.strategy), ['smaller-steps', 'compact']);
  assert.ok(!JSON.stringify(f.requests.at(-1).body.messages).includes('EARLY_DRAFT'));
});

test('an earlier compaction and full-cap recovery cannot authorize a third-step summary', { timeout: 20000 }, async t => {
  let modelCalls = 0, effects = 0;
  const f = await fixture(t, (request, res) => {
    if (request.summary) return reply(res, 'The isolated facts and receipts are preserved.');
    modelCalls++;
    if (modelCalls === 1) return reply(res, WARM_HISTORY);
    if (modelCalls === 3 || modelCalls === 5) return reply(res, '', {
      tool: { id: `mixed-${modelCalls}`, name: 'fixture_effect' },
    });
    reply(res, 'UNCOMMITTED_DRAFT', { finish: 'length', output: modelCalls === 4 ? 256 : 1 });
  }, { tools: [{ name: 'fixture_effect', description: 'Record an isolated receipt',
    parameters: { type: 'object', properties: {} },
    async execute() { effects++; return { receipt: `CONFIRMED_${effects}`, details: WARM_HISTORY }; },
  }] });
  await warm(f);
  const result = await f.driver.prompt(f.sessionId, 'Continue the fixture task.', { onPermission: () => true });
  assert.equal(result.stopReason, 'max_tokens');
  assert.equal(result.outputLimit.automaticAttempts, 2);
  assert.equal(effects, 2);
  assert.equal(modelCalls, 6);
  assert.equal(f.requests.filter(request => request.summary).length, 1, 'exhausted allowance prevents an extra summary call');
  assert.deepEqual((await f.driver.history(f.sessionId)).events.filter(event => event.type === 'plugin:codebuddy/output-recovery')
    .map(event => event.data.strategy), ['compact', 'smaller-steps']);
});

test('automatic child wakeups cannot refresh the same user request recovery allowance', { timeout: 20000 }, async t => {
  const release = Promise.withResolvers();
  let parentCalls = 0, childCalls = 0, effects = 0;
  const f = await fixture(t, async (request, res) => {
    const child = request.body.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('Your parent agent id is'));
    if (child) { childCalls++; await release.promise; return reply(res, 'CONFIRMED_CHILD_RESULT'); }
    parentCalls++;
    if (parentCalls === 1) return reply(res, '', { tool: { id: 'spawn', name: 'subagent', arguments: JSON.stringify({ role: 'code reviewer', description: 'Deferred isolated result', prompt: 'Return the isolated result.' }) } });
    if (parentCalls === 3) return reply(res, 'The earlier isolated result is preserved.');
    if (parentCalls === 5) return reply(res, '', { tool: { id: 'second-recovery-effect', name: 'fixture_effect' } });
    reply(res, 'UNCOMMITTED_DRAFT', { finish: 'length', output: 128 });
  }, { maxTokens: 128, tools: [{ name: 'fixture_effect', description: 'Count an isolated effect',
    parameters: { type: 'object', properties: {} }, async execute() { effects++; return { receipt: 'COMMITTED_ONCE' }; },
  }] });
  t.after(() => release.resolve());
  const result = await f.driver.prompt(f.sessionId, 'Delegate and finish the isolated task.', {
    onPermission: () => true,
    onEvent(event) {
      if (event.sessionId === f.sessionId && event.type === 'harness_event' && event.event.type === 'turn/end' && event.event.data.reason.kind === 'completed') release.resolve();
    },
  });
  assert.equal(result.stopReason, 'max_tokens');
  assert.equal(result.outputLimit.automaticAttempts, 2);
  assert.equal(parentCalls, 6, 'the child-triggered native turn gets only the remaining recovery');
  assert.equal(childCalls, 1);
  assert.equal(effects, 1);
  const history = await f.driver.history(f.sessionId);
  assert.equal(history.events.filter(event => event.type === 'turn/start').length, 2);
  assert.deepEqual(history.events.filter(event => event.type === 'plugin:codebuddy/output-recovery')
    .map(event => [event.data.turn, event.data.attempt]), [[1, 1], [2, 2]]);
  await f.reopen();
  assert.equal(parentCalls, 6, 'reopening the stopped parent cannot send another generation');
});

test('user cancellation at recovery admission prevents its HTTP and reopening never resends', { timeout: 15000 }, async t => {
  const controller = new AbortController();
  const f = await fixture(t, (_request, res) => reply(res, 'INCOMPLETE', { finish: 'length', output: 128 }), { maxTokens: 128 });
  const result = await f.driver.prompt(f.sessionId, 'Return the fixture result.', {
    signal: controller.signal, onEvent(event) { if (event.type === 'output_recovery') controller.abort(); },
  });
  assert.equal(result.stopReason, 'cancelled');
  assert.equal(f.requests.length, 1);
  await f.reopen();
  assert.equal(f.requests.length, 1);
});

test('a transport failure after the one recovery retains its own error and recovery evidence', { timeout: 15000 }, async t => {
  const f = await fixture(t, (_request, res, requests) => {
    if (requests.length === 1) return reply(res, 'INCOMPLETE', { finish: 'length', output: 128 });
    res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'FIXTURE_AUTH_REJECTED' } }));
  }, { maxTokens: 128 });
  await assert.rejects(f.driver.prompt(f.sessionId, 'Return the fixture result.'), error => {
    assert.notEqual(error.code, 'OUTPUT_LIMIT_REACHED');
    assert.equal(error.outputLimit.automaticAttempts, 1);
    return true;
  });
  assert.equal(f.requests.length, 2);
});

test('a native transport retry keeps the pending smaller-step recovery context', { timeout: 15000 }, async t => {
  const f = await fixture(t, (_request, res, requests) => {
    if (requests.length === 1) return reply(res, 'FAILED_DRAFT', { finish: 'length', output: 128 });
    if (requests.length === 2) return res.writeHead(503, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: { message: 'FIXTURE_TEMPORARY_OUTAGE' } }));
    reply(res, FINAL);
  }, { maxTokens: 128, retryPolicy: { mode: 'normal', maxRetries: 1,
    backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } } });
  const original = 'Complete the original isolated task.';
  const result = await f.driver.prompt(f.sessionId, original);
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.outputLimit.automaticAttempts, 1);
  assert.equal(f.requests.length, 3);
  for (const request of f.requests.slice(1)) {
    const snapshot = request.body.messages.findLast(message => message.role === 'user' &&
      typeof message.content === 'string' && message.content.startsWith('Current runtime context.'));
    assert.ok(snapshot.content.includes('using smaller tool calls and shorter file-writing chunks'));
    assert.ok(JSON.stringify(request.body.messages).includes(original));
    assert.ok(!JSON.stringify(request.body.messages).includes('FAILED_DRAFT'));
  }
});

test('parallel sessions have independent recovery allowances and manual continuation starts a new turn', { timeout: 20000 }, async t => {
  const f = await fixture(t, (_request, res) => reply(res, 'INCOMPLETE', { finish: 'length', output: 128 }), { maxTokens: 128 });
  const sibling = await f.createSibling();
  const results = await Promise.all([f.sessionId, sibling].map(id => f.driver.prompt(id, 'Complete this isolated fixture task.')));
  assert.deepEqual(results.map(result => result.outputLimit.automaticAttempts), [1, 1]);
  assert.equal(f.requests.length, 4);
  for (const id of [f.sessionId, sibling]) {
    const history = await f.driver.history(id);
    assert.equal(history.events.filter(event => event.type === 'plugin:codebuddy/output-recovery').length, 1);
  }
  await f.reopen();
  assert.equal(f.requests.length, 4);
  const continued = await f.driver.prompt(f.sessionId, 'Explicitly continue only unfinished work.');
  assert.equal(continued.outputLimit.automaticAttempts, 1);
  assert.equal(f.requests.length, 6);
});

test('failure while committing the native terminal rejects promptly instead of hanging', { timeout: 15000 }, async t => {
  const f = await fixture(t, (_request, res) => reply(res, FINAL));
  const append = Session.prototype.append;
  const mocked = t.mock.method(Session.prototype, 'append', function(type, ...args) {
    if (this.id === f.sessionId && type === 'turn/end') throw new Error('FIXTURE_TERMINAL_COMMIT_FAILED');
    return append.call(this, type, ...args);
  });
  try {
    await assert.rejects(f.driver.prompt(f.sessionId, 'Return the fixture result.', { signal: AbortSignal.timeout(5000) }), /FIXTURE_TERMINAL_COMMIT_FAILED/);
  } finally { mocked.mock.restore(); }
  assert.equal(f.requests.length, 1);
});

for (const reported of [true, false]) test(`a late child cannot restart an output-limited parent (reported usage: ${reported})`, { timeout: 20000 }, async t => {
  const releaseChild = Promise.withResolvers();
  let parentCalls = 0, childCalls = 0, manual = false;
  const f = await fixture(t, async (request, res) => {
    const child = request.body.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('Your parent agent id is'));
    if (child) {
      childCalls++;
      if (childCalls === 1) {
        await releaseChild.promise;
        return reply(res, '', { tool: { id: 'late-coordination', name: 'send_message',
          arguments: JSON.stringify({ agent_id: f.sessionId, message: 'CHILD_COORDINATION_RESULT' }) } });
      }
      return reply(res, 'CHILD_CONFIRMED_RESULT');
    }
    parentCalls++;
    if (manual) return reply(res, FINAL);
    if (parentCalls === 1) return reply(res, '', { tool: { id: 'delegate', name: 'subagent', arguments: JSON.stringify({ role: 'code reviewer', description: 'Isolated deferred child', prompt: 'Return the confirmed fixture result.' }) } });
    reply(res, 'INCOMPLETE_PARENT', { finish: 'length', output: 128, ...reported ? {} : { usage: null } });
  }, { maxTokens: 128 });
  t.after(() => releaseChild.resolve());
  const result = await f.driver.prompt(f.sessionId, 'Delegate the isolated child, then summarize it.', {
    onPermission: () => true,
    onEvent(event) {
      if (event.sessionId === f.sessionId && event.type === 'harness_event' && event.event.type === 'turn/end') releaseChild.resolve();
    },
  });
  assert.equal(result.stopReason, 'max_tokens');
  assert.equal(result.outputLimit.automaticAttempts, reported ? 1 : 0);
  assert.equal(parentCalls, reported ? 3 : 2);
  assert.equal(childCalls, 2);
  const before = await f.driver.history(f.sessionId);
  assert.equal(before.events.filter(event => event.type === 'turn/start').length, 1, 'a child notice must not create a fresh recovery allowance');
  manual = true;
  assert.equal((await f.driver.prompt(f.sessionId, 'Explicitly continue using the child result.')).stopReason, 'end_turn');
  assert.equal(parentCalls, reported ? 4 : 3);
  assert.ok(JSON.stringify(f.requests.at(-1).body.messages).includes('CHILD_CONFIRMED_RESULT'));
  assert.ok(JSON.stringify(f.requests.at(-1).body.messages).includes('CHILD_COORDINATION_RESULT'));
  const after = await f.driver.history(f.sessionId);
  assert.equal(after.events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'subagent-settled').length, 1);
});

test('an explicit parent instruction can continue a length-limited child', { timeout: 20000 }, async t => {
  let childCalls = 0, parentCalls = 0, manualCalls = 0, manual = false, childId;
  const f = await fixture(t, (request, res) => {
    const child = request.body.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('Your parent agent id is'));
    if (child) {
      childCalls++;
      return reply(res, childCalls <= 2 ? 'CHILD_INCOMPLETE' : 'CHILD_FINISHED_AFTER_PARENT_INSTRUCTION', childCalls <= 2 ? { finish: 'length', output: 128 } : {});
    }
    if (manual && manualCalls++ === 0) return reply(res, '', { tool: { id: 'continue-child', name: 'send_message', arguments: JSON.stringify({ agent_id: childId, message: 'Continue the unfinished child task explicitly.' }) } });
    if (parentCalls++ === 0) return reply(res, '', { tool: { id: 'spawn-child', name: 'subagent', arguments: JSON.stringify({ role: 'code reviewer', description: 'Length limited child', prompt: 'Perform the isolated child task.' }) } });
    reply(res, FINAL);
  }, { maxTokens: 128 });
  const observe = event => { if (event.type === 'subagent_start') childId = event.childSessionId; };
  assert.equal((await f.driver.prompt(f.sessionId, 'Delegate the isolated task.', { onEvent: observe, onPermission: () => true })).stopReason, 'end_turn');
  assert.ok(childId);
  assert.equal(childCalls, 2);
  manual = true;
  assert.equal((await f.driver.prompt(f.sessionId, 'Explicitly tell the same child to continue.', { onPermission: () => true })).stopReason, 'end_turn');
  assert.equal(childCalls, 3, 'the parent instruction must actually open a new child request');
});

async function warm(f) {
  const result = await f.driver.prompt(f.sessionId, 'Record the fixture facts for the next turn.');
  assert.equal(result.stopReason, 'end_turn');
}

test('large-window pressure honors the native threshold and preserves history at ten percent', {timeout: 45000}, async t => {
  for (const custom of [false, true]) {
    let normal = 0;
    const marker = 'LONG_WORKSPACE_HISTORY_';
    const f = await fixture(t, (request, res) => {
      if (request.summary) return reply(res, 'Checkpoint: keep the project test command.');
      if (++normal <= 4) {
        const prompt = 500 + (normal - 1) * 23000;
        return reply(res, (normal === 1 ? marker : 'RECENT_WORKSPACE_NOTES_').repeat(4000),
          { usage: { prompt_tokens: prompt, completion_tokens: 23000, total_tokens: prompt + 23000 } });
      }
      reply(res, FINAL);
    }, { contextWindow: 1048576, useDefaultBudget: true, defaultPressure: !custom });
    for (let turn = 0; turn < 4; turn++) await warm(f);
    await f.driver.prompt(f.sessionId, 'Continue using the project history.');
    const next = f.requests.filter(r => !r.summary).at(-1);
    assert.equal(f.requests.some(r => r.summary), false);
    assert.ok(JSON.stringify(next.body.messages).includes(marker));
    const usage = await f.driver.contextUsage(f.sessionId);
    assert.equal(usage.pressureThreshold, Math.floor(1048576 * (custom ? 0.99 : 0.8)));
    f.options.autoCompact = false;
    await f.configure();
    assert.equal((await f.driver.contextUsage(f.sessionId)).pressureThreshold, undefined);
  }
});

test('a disconnected summary cools down across prompts and manual retry can recover', { timeout: 30000 }, async t => {
  let online = false;
  const f = await fixture(t, (request, res) => {
    if (request.summary && !online) return res.destroy();
    reply(res, request.summary ? 'Retain the completed receipt.' : WARM_HISTORY);
  }, { retryPolicy: { mode: 'normal', maxRetries: 0 } });
  await warm(f);
  f.options.autoCompactThreshold = 0.05;
  f.options.compactionFallbacks = [{
    source: { provider: f.provider, model: 'fixture' },
    fallbacks: [{ fallback: { provider: { ...f.provider, id: 'backup' }, model: 'backup' } }],
  }];
  await f.configure();
  const summariesSent = () => f.requests.filter(r => r.summary).length;
  await f.driver.prompt(f.sessionId, 'Continue stage one.');
  const first = summariesSent();
  assert.deepEqual(f.requests.filter(r => r.summary).map(r => r.body.model), ['fixture', 'backup']);
  await f.driver.prompt(f.sessionId, 'Continue stage two.');
  assert.equal(summariesSent(), first);
  online = true;
  await f.driver.compact(f.sessionId);
  assert.equal(summaries(await f.driver.history(f.sessionId)).length, 1);
});

test('pressure after a model switch uses the destination window and summary route', { timeout: 30000 }, async t => {
  for (const expanding of [true, false]) {
    const f = await fixture(t, (request, res) => reply(res, request.summary ? 'Keep the prior stage.' :
      'Recorded fixture facts with a completed receipt. '.repeat(4100),
      { usage: { prompt_tokens: 500, completion_tokens: 55000, total_tokens: 55500 } }),
      { contextWindow: expanding ? 65536 : 1048576, defaultPressure: true, useDefaultBudget: true });
    await warm(f);
    const provider = { ...f.provider, id: 'destination', contextWindow: expanding ? 1048576 : 65536 };
    await f.driver.createSession({ sessionId: f.sessionId, cwd: f.root, provider, model: 'destination', options: f.options });
    const start = f.requests.length;
    await f.driver.prompt(f.sessionId, 'Continue with the selected model.');
    const requests = f.requests.slice(start);
    assert.ok(requests.length && requests.every(r => r.body.model === 'destination'));
    assert.equal(requests.some(r => r.summary), !expanding);
    assert.equal(requests.at(-1).summary, false);
  }
});

async function observeFits(t) {
  const { PiAiAdapter } = await import('@deepseek-ai/dsh-llm-pi-ai');
  const fits = [], prepare = PiAiAdapter.prototype.prepareRequestWithSnapshot;
  t.mock.method(PiAiAdapter.prototype, 'prepareRequestWithSnapshot', async function(options, snapshot) {
    const prepared = await prepare.call(this, options, snapshot);
    fits.push({ purpose: options.purpose, fit: prepared.fit, messageIds: options.messages.map(message => message.id).filter(Boolean) });
    return prepared;
  });
  return fits;
}

test('an exhausted uncompressible current input never dispatches the main request with one token', { timeout: 15000 }, async t => {
  const f = await fixture(t, (_request, res) => reply(res, 'UNEXPECTED_HTTP'), { contextWindow: 8192 });
  const currentRequest = 'Oversized uncompressible first input. '.repeat(1000);
  await assert.rejects(f.driver.prompt(f.sessionId, currentRequest), { code: 'LOCAL_OUTPUT_BUDGET_EXHAUSTED' });
  assert.equal(f.requests.filter(request => !request.summary).length, 0, 'the original or unchanged retry must never reach HTTP');
  assert.ok(f.requests.filter(request => request.summary).length <= 1, 'generated context may be summarized once, without replacing the current input');
  const history = await f.driver.history(f.sessionId);
  assert.equal(failures(history).at(-1).code, 'LOCAL_OUTPUT_BUDGET_EXHAUSTED');
  assert.equal(history.events.at(-1).data.reason.kind, 'error');
  const projected = new Session(history.meta.id, history.events, history.meta, 'snapshot', history.inheritedEventCount);
  const original = history.events.find(event => event.type === 'user/message' && event.data.source?.kind === 'user' && event.data.content.some(block => block.text === currentRequest));
  assert.ok(original);
  assert.ok(summaries(history).every(event => !event.data.shadowedSeqs.includes(original.seq)), 'even an insufficient recovery summary cannot shadow the latest human input');
  assert.deepEqual(projected.deriveMessages().find(message => message.id === original.data.id), original.data);
  assert.ok(f.requests.filter(request => request.summary).every(request => !JSON.stringify(request.body.messages).includes(currentRequest)), 'an attempted auxiliary summary must also exclude the original human input');
  await f.reopen();
  assert.equal(failures(await f.driver.history(f.sessionId)).at(-1).code, 'LOCAL_OUTPUT_BUDGET_EXHAUSTED', 'the existing v4 format must restore the local failure');
});

test('native driver recovery retains the exact current user through retry and v4 cold restore', { timeout: 15000 }, async t => {
  let modelCalls = 0;
  const currentRequest = 'Use only recorded receipts. Do not invoke tools or write files. Answer in at most 100 characters.';
  const f = await fixture(t, (request, res) => {
    // The mock summary deliberately omits the latest user instruction.
    if (request.summary) return reply(res, 'The earlier fixture work has completed receipts.');
    modelCalls++;
    if (modelCalls === 1) return reply(res, WARM_HISTORY);
    if (modelCalls === 2) return reply(res, 'PARTIAL_TRUNCATED', { finish: 'length', output: 1 });
    reply(res, FINAL);
  });
  await warm(f);
  assert.equal((await f.driver.prompt(f.sessionId, currentRequest)).stopReason, 'end_turn');
  assert.equal(modelCalls, 3);
  assert.equal(f.requests.filter(request => request.summary).length, 1);
  assert.ok(f.requests.every(request => (request.body.max_completion_tokens ?? request.body.max_tokens) > 1));
  let history = await f.driver.history(f.sessionId);
  assert.equal(failures(history).at(-1).code, 'OUTPUT_TRUNCATED');
  assert.equal(summaries(history).length, 1);
  assert.equal(history.events.filter(event => event.type === 'turn/end').length, 2);
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1).body.messages), /PARTIAL_TRUNCATED/, 'an audited failed attempt must not become successful assistant history');
  const original = history.events.find(event => event.type === 'user/message' && event.data.source?.kind === 'user' && event.data.content.some(block => block.text === currentRequest));
  assert.ok(original, 'the actual RPC input must have canonical user provenance');
  assert.ok(!summaries(history)[0].data.shadowedSeqs.includes(original.seq));
  const retryMessages = f.requests.at(-1).body.messages;
  assert.ok(retryMessages.some(message => JSON.stringify(message.content).includes(currentRequest)), 'the wire retry includes the complete exact human input independently of summary quality');
  const surfaceBeforeRestore = new Session(history.meta.id, history.events, history.meta, 'snapshot', history.inheritedEventCount);
  const messagesBeforeRestore = surfaceBeforeRestore.deriveMessages();
  assert.deepEqual(messagesBeforeRestore.find(message => message.id === original.data.id), original.data);
  await f.reopen();
  history = await f.driver.history(f.sessionId);
  assert.equal(failures(history).at(-1).code, 'OUTPUT_TRUNCATED');
  assert.equal(summaries(history).length, 1);
  const restored = new Session(history.meta.id, history.events, history.meta, 'snapshot', history.inheritedEventCount);
  assert.deepEqual(restored.deriveMessages(), messagesBeforeRestore, 'cold restore preserves message IDs, exact contents and chronological order');
  assert.deepEqual(history.events.find(event => event.seq === original.seq), original);
  assert.equal(history.events.filter(event => event.type === 'user/message' && event.data.id === original.data.id).length, 1, 'no copied or reordered replacement user event is persisted');
});

test('local budget exhaustion compacts retained history before dispatching the retried request', { timeout: 15000 }, async t => {
  const fits = await observeFits(t);
  let modelCalls = 0;
  const f = await fixture(t, (request, res) => {
    if (request.summary) return reply(res, 'Preserve the completed fixture facts.');
    modelCalls++;
    // The current input exhausts the main request, while the old history can
    // still be summarized with its complete 4096-token output reservation.
    reply(res, modelCalls === 1 ? WARM_HISTORY.slice(0, Math.floor(WARM_HISTORY.length * 0.8)) : FINAL);
  }, { contextWindow: 16384 });
  await warm(f);
  assert.equal((await f.driver.prompt(f.sessionId, 'A current request requiring the retained fixture facts. '.repeat(450))).stopReason, 'end_turn');
  assert.equal(modelCalls, 2, 'the exhausted original attempt must never reach HTTP');
  const summaryCount = f.requests.filter(request => request.summary).length;
  assert.ok(summaryCount >= 1 && summaryCount <= 8, 'balanced segments must converge within the bounded compaction attempt');
  assert.ok(fits.some(item => item.purpose === undefined && item.fit.available < item.fit.minimumMaxTokens));
  assert.ok(f.requests.filter(request => request.summary).every(request => (request.body.max_completion_tokens ?? request.body.max_tokens) === 4096),
    'failed local fit probes may shrink the range, but every dispatched summary keeps its full output reservation');
  assert.ok(f.requests.every(request => (request.body.max_completion_tokens ?? request.body.max_tokens) > 1));
  const history = await f.driver.history(f.sessionId);
  assert.equal(failures(history).at(-1).code, 'LOCAL_OUTPUT_BUDGET_EXHAUSTED');
  assert.equal(summaries(history).length, summaryCount);
  assert.equal(history.events.filter(event => event.type === 'plugin:codebuddy/output-recovery').length, 1,
    'multiple improving summaries consume exactly one generation recovery allowance');
});

test('a second short length result stops even under an always retry policy', { timeout: 15000 }, async t => {
  let modelCalls = 0;
  const f = await fixture(t, (request, res) => {
    if (request.summary) return reply(res, 'Retain the already completed fixture facts.');
    modelCalls++;
    reply(res, modelCalls === 1 ? WARM_HISTORY : 'PARTIAL_TRUNCATED', modelCalls === 1 ? {} : { finish: 'length', output: 1 });
  }, { retryPolicy: { mode: 'always', backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } } });
  await warm(f);
  assert.equal((await f.driver.prompt(f.sessionId, 'Continue the fixture.')).stopReason, 'max_tokens');
  assert.equal(modelCalls, 3, 'one original attempt and one recovery attempt follow warm-up');
  assert.equal(f.requests.filter(request => request.summary).length, 1);
  const history = await f.driver.history(f.sessionId);
  assert.equal(failures(history).filter(failure => failure.code === 'OUTPUT_TRUNCATED').length, 2);
  assert.equal(history.events.filter(event => event.type === 'llm/retry').length, 0, 'generic transport retry must not take ownership of local budget recovery');
  assert.equal(history.events.at(-1).data.reason.kind, 'error');
});

test('a first-turn truncated result with no useful task history stops without replaying the model call', { timeout: 15000 }, async t => {
  const f = await fixture(t, (_request, res) => reply(res, 'PARTIAL_TRUNCATED', { finish: 'length', output: 1 }));
  assert.equal((await f.driver.prompt(f.sessionId, 'A first-turn request with no preceding history.')).stopReason, 'max_tokens');
  assert.equal(f.requests.filter(request => !request.summary).length, 1);
  assert.ok(f.requests.filter(request => request.summary).length <= 1, 'generated request context may be considered once, but cannot authorize an unchanged retry');
  assert.equal(summaries(await f.driver.history(f.sessionId)).length, 0);
});

test('provider-confirmed context overflow keeps its separate native recovery classification', { timeout: 15000 }, async t => {
  let modelCalls = 0;
  const f = await fixture(t, (request, res) => {
    if (request.summary) return reply(res, 'Preserve the completed fixture facts.');
    modelCalls++;
    if (modelCalls === 1) return reply(res, WARM_HISTORY);
    if (modelCalls === 2) return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'maximum context length exceeded' } }));
    reply(res, FINAL);
  });
  await warm(f);
  assert.equal((await f.driver.prompt(f.sessionId, 'Continue after the provider overflow.')).stopReason, 'end_turn');
  assert.equal(modelCalls, 3);
  assert.equal(f.requests.filter(request => request.summary).length, 1);
  const history = await f.driver.history(f.sessionId);
  assert.equal(failures(history).at(-1).code, 'CONTEXT_WINDOW_EXCEEDED');
  assert.equal(summaries(history).length, 1);
});

test('a summary that makes no useful reduction does not authorize retry', { timeout: 15000 }, async t => {
  let modelCalls = 0;
  const f = await fixture(t, (request, res) => {
    if (request.summary) return reply(res, WARM_HISTORY.repeat(2));
    modelCalls++;
    reply(res, modelCalls === 1 ? WARM_HISTORY : 'PARTIAL_TRUNCATED', modelCalls === 1 ? {} : { finish: 'length', output: 1 });
  });
  await warm(f);
  assert.equal((await f.driver.prompt(f.sessionId, 'Continue the fixture.')).stopReason, 'max_tokens');
  assert.equal(modelCalls, 2);
  assert.equal(f.requests.filter(request => request.summary).length, 1);
  assert.equal(summaries(await f.driver.history(f.sessionId)).length, 0);
});

test('summary input that cannot reserve its own output never reaches HTTP and preserves the original failure', { timeout: 15000 }, async t => {
  const fits = await observeFits(t);
  let modelCalls = 0;
  // Model two measured states: room for the initial turn, then no room for
  // either the next turn or its auxiliary summary after history is retained.
  const f = await fixture(t, (request, res) => {
    modelCalls++;
    // Enough retained history to exhaust this small fixture without making the
    // auxiliary report itself larger than the model's entire usable context.
    reply(res, modelCalls === 1 ? 'large fixture history '.repeat(100) : 'UNEXPECTED_HTTP');
  }, { contextWindow: 8448, count: () => modelCalls === 0 ? 2048 : 8448 });
  await warm(f);
  await assert.rejects(f.driver.prompt(f.sessionId, 'Continue the fixture.'), { code: 'LOCAL_OUTPUT_BUDGET_EXHAUSTED' });
  assert.equal(modelCalls, 1);
  assert.equal(f.requests.filter(request => request.summary).length, 0);
  const summaryFits = fits.filter(item => item.purpose === 'compaction');
  assert.ok(summaryFits.length > 0);
  assert.ok(summaryFits.every(item => item.fit.effectiveMaxTokens < item.fit.desiredMaxTokens));
  const history = await f.driver.history(f.sessionId);
  assert.ok(history.events.some(event => event.type === 'compaction/start'));
  assert.equal(summaries(history).length, 0);
});

test('cancellation during recovery summary prevents a model retry', { timeout: 15000 }, async t => {
  let modelCalls = 0, summaryCalls = 0;
  const controller = new AbortController();
  const f = await fixture(t, (request, res) => {
    if (request.summary) { summaryCalls++; controller.abort(); return; }
    modelCalls++;
    reply(res, modelCalls === 1 ? WARM_HISTORY : 'PARTIAL_TRUNCATED', modelCalls === 1 ? {} : { finish: 'length', output: 1 });
  });
  await warm(f);
  assert.equal((await f.driver.prompt(f.sessionId, 'Continue the fixture.', { signal: controller.signal })).stopReason, 'cancelled');
  assert.equal(modelCalls, 2);
  assert.equal(summaryCalls, 1);
  assert.equal(summaries(await f.driver.history(f.sessionId)).length, 0);
});

test('explicit caps get at most one generation recovery, while ordinary stop does not retry', { timeout: 20000 }, async t => {
  for (const { cap, finish, output, stopReason } of [
    { cap: 1, finish: 'length', output: 1, stopReason: 'max_tokens' },
    { cap: 128, finish: 'length', output: 128, stopReason: 'max_tokens' },
    { cap: 128, finish: 'stop', output: 1, stopReason: 'end_turn' },
  ]) {
    const f = await fixture(t, (_request, res) => reply(res, 'Fixture output.', { finish, output }), { maxTokens: cap });
    const result = await f.driver.prompt(f.sessionId, 'Return a small fixture answer.');
    assert.equal(result.stopReason, stopReason);
    assert.equal(f.requests.length, finish === 'length' ? 2 : 1);
    assert.equal(result.outputLimit?.automaticAttempts, finish === 'length' ? 1 : undefined);
    assert.equal(f.requests[0].body.max_completion_tokens ?? f.requests[0].body.max_tokens, cap);
    const history = await f.driver.history(f.sessionId);
    assert.equal(failures(history).length, finish === 'length' ? 2 : 0);
    assert.equal(summaries(history).length, 0);
  }
});

test('length with absent or input-only usage retains an unknown output count without recovery', { timeout: 15000 }, async t => {
  for (const usage of [null, { prompt_tokens: 500 }, { prompt_tokens: 65535 }]) {
    const f = await fixture(t, (_request, res) => reply(res, 'Visible text before the length stop.', { finish: 'length', usage }), { maxTokens: 128 });
    assert.equal((await f.driver.prompt(f.sessionId, 'Return a fixture answer with an output cap.')).stopReason, 'max_tokens');
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].body.max_completion_tokens ?? f.requests[0].body.max_tokens, 128);
    const history = await f.driver.history(f.sessionId);
    assert.equal(failures(history).length, 1, 'the raw length stop remains a failed generation, without inventing an output count');
    assert.equal(failures(history)[0].code, 'OUTPUT_LENGTH_STOP');
    assert.equal(summaries(history).length, 0);
    assert.equal(history.events.filter(event => event.type === 'compaction/start' || event.type === 'llm/retry').length, 0);
    assert.equal(history.events.at(-1).data.reason.kind, 'error');
  }
});

test('Responses rejects an explicit cap below its minimum without HTTP or an always-policy retry', { timeout: 15000 }, async t => {
  const f = await fixture(t, (_request, res) => res.writeHead(500).end('UNEXPECTED_HTTP'), {
    protocol: 'openai-responses', maxTokens: 1,
    retryPolicy: { mode: 'always', backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } },
  });
  await assert.rejects(f.driver.prompt(f.sessionId, 'Return a fixture answer.', { signal: AbortSignal.timeout(5000) }), { code: 'INVALID_OUTPUT_BUDGET' });
  assert.equal(f.requests.length, 0);
  const history = await f.driver.history(f.sessionId);
  assert.equal(failures(history).at(-1).code, 'INVALID_OUTPUT_BUDGET');
  assert.equal(history.events.filter(event => event.type === 'compaction/start' || event.type === 'llm/retry').length, 0);
  assert.equal(summaries(history).length, 0);
  assert.equal(history.events.at(-1).data.reason.kind, 'error');
});

test('request-fit recovery never replays a completed tool or loses its native receipt', { timeout: 15000 }, async t => {
  let modelCalls = 0, effects = 0;
  const f = await fixture(t, (request, res) => {
    if (request.summary) return reply(res, 'The earlier fixture facts remain valid; the effect receipt is retained verbatim.');
    modelCalls++;
    if (modelCalls === 1) return reply(res, WARM_HISTORY);
    if (modelCalls === 2) return reply(res, '', { tool: { id: 'effect-once', name: 'fixture_effect' } });
    if (modelCalls === 3) return reply(res, 'PARTIAL_TRUNCATED', { finish: 'length', output: 1 });
    reply(res, FINAL);
  }, { tools: [{ name: 'fixture_effect', description: 'An isolated counted effect', parameters: { type: 'object', properties: {} }, async execute() { effects++; return { receipt: 'EFFECT_COMPLETED_ONCE' }; } }] });
  await warm(f);
  const result = await f.driver.prompt(f.sessionId, 'Execute the fixture effect once, then report its receipt.', { onPermission: () => true });
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(effects, 1);
  assert.equal(modelCalls, 4);
  assert.equal(f.requests.filter(request => request.summary).length, 1);
  assert.ok(f.requests.at(-1).body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'effect-once'));
  const history = await f.driver.history(f.sessionId);
  assert.equal(history.events.filter(event => event.type === 'tool/result' && event.data.message.toolCallId === 'effect-once').length, 1);
  assert.equal(history.events.at(-1).data.reason.kind, 'completed');
});

test('a long first turn compacts completed tool history after its exact user input without replaying effects', { timeout: 15000 }, async t => {
  let modelCalls = 0, effects = 0;
  const currentRequest = 'Perform the two isolated fixture effects once each, then report their recorded receipts.';
  const f = await fixture(t, (request, res) => {
    if (request.summary) return reply(res, 'The first fixture effect completed successfully.');
    modelCalls++;
    if (modelCalls <= 2) return reply(res, '', { tool: { id: `long-first-turn-${modelCalls}`, name: 'fixture_effect' } });
    if (modelCalls === 3) return reply(res, 'PARTIAL_TRUNCATED', { finish: 'length', output: 1 });
    reply(res, FINAL);
  }, { tools: [{
    name: 'fixture_effect', description: 'An isolated counted effect', parameters: { type: 'object', properties: {} },
    async execute() { effects++; return { receipt: `EFFECT_${effects}_COMPLETED`, details: WARM_HISTORY }; },
  }] });
  assert.equal((await f.driver.prompt(f.sessionId, currentRequest, { onPermission: () => true })).stopReason, 'end_turn');
  assert.equal(effects, 2);
  assert.equal(modelCalls, 4);
  assert.equal(f.requests.filter(request => request.summary).length, 1);
  const history = await f.driver.history(f.sessionId);
  const original = history.events.find(event => event.type === 'user/message' && event.data.source?.kind === 'user');
  const summary = summaries(history)[0];
  assert.ok(!summary.data.shadowedSeqs.includes(original.seq));
  const shadowed = summary.data.shadowedSeqs.map(seq => history.events.find(event => event.seq === seq));
  assert.ok(shadowed.some(event => event.type === 'tool/result' && event.data.message.toolCallId === 'long-first-turn-1'));
  const projected = new Session(history.meta.id, history.events, history.meta, 'snapshot', history.inheritedEventCount);
  assert.deepEqual(projected.deriveMessages().find(message => message.id === original.data.id), original.data);
  assert.ok(f.requests.at(-1).body.messages.some(message => JSON.stringify(message.content).includes(currentRequest)));
  assert.ok(f.requests.at(-1).body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'long-first-turn-2'));
  for (const callId of ['long-first-turn-1', 'long-first-turn-2']) {
    const receipts = history.events.filter(event => event.type === 'tool/result' && event.data.message.toolCallId === callId);
    assert.equal(receipts.filter(event => event.surfaceOp === 'append').length, 1, 'each effect has exactly one original native receipt');
    for (const replacement of receipts.filter(event => event.surfaceOp !== 'append'))
      assert.ok(replacement.sourceEventSeqs.includes(receipts[0].seq), 'native pruning keeps a durable reference to the original receipt');
  }
});

test('summary full-fit selection sends one complete-cap HTTP and preserves the omitted native tail', { timeout: 15000 }, async t => {
  const fits = await observeFits(t);
  let modelCalls = 0;
  const f = await fixture(t, (request, res) => {
    if (request.summary) return reply(res, 'Earlier fixture facts are recorded.');
    modelCalls++;
    if (modelCalls === 1) return reply(res, WARM_HISTORY);
    if (modelCalls === 2) return reply(res, 'PARTIAL_TRUNCATED', { finish: 'length', output: 1 });
    reply(res, FINAL);
  }, { contextWindow: 16384 });
  await warm(f);
  assert.equal((await f.driver.prompt(f.sessionId, 'Use the recorded facts without tools or file writes.')).stopReason, 'end_turn');
  const summaryFits = fits.filter(item => item.purpose === 'compaction');
  t.diagnostic(JSON.stringify({ fixture: 'summary-full-fit', fits: fits.map(({ purpose, fit }) => ({ purpose, tokens: fit.estimate.tokens, desired: fit.desiredMaxTokens, effective: fit.effectiveMaxTokens })) }));
  assert.ok(summaryFits.length >= 2, 'the original summary must be rejected locally before selecting a smaller region');
  assert.ok(summaryFits[0].fit.effectiveMaxTokens < summaryFits[0].fit.desiredMaxTokens);
  assert.equal(summaryFits.at(-1).fit.effectiveMaxTokens, summaryFits.at(-1).fit.desiredMaxTokens);
  const summaryRequests = f.requests.filter(request => request.summary);
  assert.equal(summaryRequests.length, 1);
  assert.equal(summaryRequests[0].body.max_completion_tokens ?? summaryRequests[0].body.max_tokens, summaryFits.at(-1).fit.desiredMaxTokens);
  assert.equal(modelCalls, 3);
  const history = await f.driver.history(f.sessionId), summary = summaries(history)[0];
  assert.equal(summaries(history).length, 1);
  const restored = new Session(history.meta.id, history.events, history.meta, 'snapshot', history.inheritedEventCount);
  const shadowedIds = summary.data.shadowedSeqs.map(seq => restored.deriveEventMessage(restored.eventAt(seq))?.id).filter(Boolean);
  const activeSystem = history.events.findLast(event => event.type === 'system/message' && event.seq < summary.seq);
  const [preparedSystemId, ...selectedInputIds] = summaryFits.at(-1).messageIds;
  assert.ok(activeSystem, 'a system prompt precedes the checkpoint');
  assert.equal(preparedSystemId, activeSystem.data.message.id, 'the summary uses the system prompt active at the checkpoint');
  assert.deepEqual(shadowedIds, selectedInputIds, 'the checkpoint shadows exactly the final prepared summary input');
  const tail = history.events.find(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.text === WARM_HISTORY));
  assert.ok(!summary.data.shadowedSeqs.includes(tail.seq));
  assert.deepEqual(restored.deriveMessages().find(message => message.id === tail.data.message.id), tail.data.message);
  const current = history.events.findLast(event => event.type === 'user/message' && event.data.source?.kind === 'user');
  assert.deepEqual(restored.deriveMessages().find(message => message.id === current.data.id), current.data);
  const before = restored.deriveMessages();
  await f.reopen();
  const cold = await f.driver.history(f.sessionId);
  assert.deepEqual(new Session(cold.meta.id, cold.events, cold.meta, 'snapshot', cold.inheritedEventCount).deriveMessages(), before);
});

test('a dispatched full-cap summary length stops with no second summary HTTP or checkpoint commit', { timeout: 15000 }, async t => {
  const fits = await observeFits(t);
  let modelCalls = 0;
  const f = await fixture(t, (request, res) => {
    if (request.summary) return reply(res, 'INCOMPLETE_CHECKPOINT', { finish: 'length', output: 548 });
    modelCalls++;
    reply(res, modelCalls === 1 ? WARM_HISTORY : 'PARTIAL_TRUNCATED', modelCalls === 1 ? {} : { finish: 'length', output: 1 });
  });
  await warm(f);
  assert.equal((await f.driver.prompt(f.sessionId, 'Continue the exact recorded task.')).stopReason, 'max_tokens');
  const summaryFits = fits.filter(item => item.purpose === 'compaction');
  assert.equal(summaryFits.length, 1);
  assert.equal(summaryFits[0].fit.effectiveMaxTokens, summaryFits[0].fit.desiredMaxTokens);
  assert.equal(f.requests.filter(request => request.summary).length, 1);
  assert.equal(modelCalls, 2);
  assert.equal(summaries(await f.driver.history(f.sessionId)).length, 0);
});

test('deployed tokenizer prices the dispatched messages and tools, reducing output before HTTP', async t => {
  const measured = [];
  const f = await fixture(t, (_req, res) => reply(res, FINAL), { contextWindow: 65536, maxTokens: 8192,
    count: body => { measured.push(body); return 58666; } });
  const fits = await observeFits(t);
  assert.equal((await f.driver.prompt(f.sessionId, 'Reply with the verification.')).stopReason, 'end_turn');
  assert.equal(f.requests.length, 1);
  const wire = f.requests[0].body;
  const agentMeasurement = measured.find(body => !body.tools?.some(tool => tool.function?.name === 'check_execution_claims'));
  assert.deepEqual(agentMeasurement.messages, wire.messages);
  assert.deepEqual(agentMeasurement.tools, wire.tools);
  assert.deepEqual(agentMeasurement.chat_template_kwargs, wire.chat_template_kwargs);
  assert.equal(wire.max_completion_tokens ?? wire.max_tokens, 65536 - 58666 - 4096);
  assert.equal(fits.at(-1).fit.source, 'vllm-tokenizer');
});

test('provider overflow of the first summary halves the span; unrelated 400 does not shrink', async t => {
  for (const overflow of [true, false]) {
    let summaryCalls = 0, mainCalls = 0;
    const bad = (res, message) => res.writeHead(400, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: { type: 'BadRequestError', code: 400, message } }));
    const rejection = "This model's maximum context length is 65536 tokens. However, you requested 4096 output tokens and your prompt contains at least 61441 input tokens, for a total of at least 65537 tokens.";
    const f = await fixture(t, (req, res) => {
      if (req.summary) {
        if (++summaryCalls === 1) return bad(res, overflow ? rejection : 'unsupported tool schema');
        return reply(res, 'Earlier facts were recorded.');
      }
      if (++mainCalls === 3) return bad(res, rejection);
      return reply(res, mainCalls < 3 ? WARM_HISTORY : FINAL);
    });
    await warm(f);
    await warm(f);
    const attempt = f.driver.prompt(f.sessionId, 'Continue from the latest request.');
    if (overflow) {
      assert.equal((await attempt).stopReason, 'end_turn');
      const summaries = f.requests.filter(r => r.summary);
      assert.ok(summaries.length >= 2);
      assert.ok(summaries[1].body.messages.length < summaries[0].body.messages.length);
    } else {
      await assert.rejects(attempt);
      assert.equal(summaryCalls, 1);
    }
  }
});
