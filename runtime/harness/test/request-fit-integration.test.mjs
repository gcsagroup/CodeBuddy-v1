import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
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
  if (tool) emit({ tool_calls: [{ index: 0, id: tool.id, type: 'function', function: { name: tool.name, arguments: '{}' } }] });
  emit({}, tool ? 'tool_calls' : finish);
  if (usage !== null) res.write(`data: ${JSON.stringify({ id: 'request-fit-fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [], usage })}\n\n`);
  res.end('data: [DONE]\n\n');
}

async function fixture(t, handler, { contextWindow = 65536, maxTokens = 256, protocol = 'openai-completions', retryPolicy, tools } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'harness-request-fit-'));
  const requests = [];
  const f = { requests, root };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    const lastContent = (body.messages ?? body.input)?.at(-1)?.content;
    const lastText = typeof lastContent === 'string' ? lastContent : (lastContent ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
    // This fixture identifies the SDK's auxiliary directive only to choose a
    // mock response. It must still recognize a summary whose cap was clamped.
    const request = { body, summary: lastText.startsWith('You are now acting as a compaction engine for this AI coding assistant.') };
    requests.push(request);
    await handler(request, res, requests);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = { id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-only', contextWindow, protocol, ...(retryPolicy ? { retryPolicy } : {}) };
  const options = { maxTokens, autoCompactThreshold: 0.99, ...(tools ? { tools } : {}) };
  const open = async () => {
    f.driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd: root });
    const session = await f.driver.createSession({ ...(f.sessionId ? { sessionId: f.sessionId } : {}), cwd: root, provider, model: 'fixture', options });
    f.sessionId = session.sessionId;
  };
  t.after(async () => { await f.driver?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await open();
  f.reopen = async () => { await f.driver.close(); await open(); };
  return f;
}

const failures = history => history.events
  .filter(event => event.type === 'assistant/attempt')
  .flatMap(event => event.data.stream)
  .filter(record => record.type === 'chunk' && record.chunk.type === 'finish')
  .map(record => record.chunk.reason.failure)
  .filter(Boolean);
const summaries = history => history.events.filter(event => event.type === 'compaction/summary');

async function warm(f) {
  const result = await f.driver.prompt(f.sessionId, 'Record the fixture facts for the next turn.');
  assert.equal(result.stopReason, 'end_turn');
}

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
  assert.equal(f.requests.filter(request => request.summary).length, 1);
  assert.ok(fits.some(item => item.purpose === undefined && item.fit.available < item.fit.minimumMaxTokens));
  assert.ok(fits.filter(item => item.purpose === 'compaction').every(item => item.fit.effectiveMaxTokens === item.fit.desiredMaxTokens));
  assert.ok(f.requests.every(request => (request.body.max_completion_tokens ?? request.body.max_tokens) > 1));
  const history = await f.driver.history(f.sessionId);
  assert.equal(failures(history).at(-1).code, 'LOCAL_OUTPUT_BUDGET_EXHAUSTED');
  assert.equal(summaries(history).length, 1);
});

test('a second short length result stops even under an always retry policy', { timeout: 15000 }, async t => {
  let modelCalls = 0;
  const f = await fixture(t, (request, res) => {
    if (request.summary) return reply(res, 'Retain the already completed fixture facts.');
    modelCalls++;
    reply(res, modelCalls === 1 ? WARM_HISTORY : 'PARTIAL_TRUNCATED', modelCalls === 1 ? {} : { finish: 'length', output: 1 });
  }, { retryPolicy: { mode: 'always', backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } } });
  await warm(f);
  await assert.rejects(f.driver.prompt(f.sessionId, 'Continue the fixture.'), { code: 'OUTPUT_TRUNCATED' });
  assert.equal(modelCalls, 3, 'one original attempt and one recovery attempt follow warm-up');
  assert.equal(f.requests.filter(request => request.summary).length, 1);
  const history = await f.driver.history(f.sessionId);
  assert.equal(failures(history).filter(failure => failure.code === 'OUTPUT_TRUNCATED').length, 2);
  assert.equal(history.events.filter(event => event.type === 'llm/retry').length, 0, 'generic transport retry must not take ownership of local budget recovery');
  assert.equal(history.events.at(-1).data.reason.kind, 'error');
});

test('a first-turn truncated result with no useful task history stops without replaying the model call', { timeout: 15000 }, async t => {
  const f = await fixture(t, (_request, res) => reply(res, 'PARTIAL_TRUNCATED', { finish: 'length', output: 1 }));
  await assert.rejects(f.driver.prompt(f.sessionId, 'A first-turn request with no preceding history.'), { code: 'OUTPUT_TRUNCATED' });
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
  await assert.rejects(f.driver.prompt(f.sessionId, 'Continue the fixture.'), { code: 'OUTPUT_TRUNCATED' });
  assert.equal(modelCalls, 2);
  assert.equal(f.requests.filter(request => request.summary).length, 1);
  assert.equal(summaries(await f.driver.history(f.sessionId)).length, 0);
});

test('summary input that cannot reserve its own output never reaches HTTP and preserves the original failure', { timeout: 15000 }, async t => {
  const fits = await observeFits(t);
  let modelCalls = 0;
  const f = await fixture(t, (request, res) => {
    modelCalls++;
    reply(res, modelCalls === 1 ? 'large fixture history '.repeat(2000) : 'UNEXPECTED_HTTP');
  }, { contextWindow: 8192 });
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

test('explicit cap one, cap 128 and ordinary stop remain terminal without compaction', { timeout: 20000 }, async t => {
  for (const { cap, finish, output, stopReason } of [
    { cap: 1, finish: 'length', output: 1, stopReason: 'max_tokens' },
    { cap: 128, finish: 'length', output: 128, stopReason: 'max_tokens' },
    { cap: 128, finish: 'stop', output: 1, stopReason: 'end_turn' },
  ]) {
    const f = await fixture(t, (_request, res) => reply(res, 'Fixture output.', { finish, output }), { maxTokens: cap });
    assert.equal((await f.driver.prompt(f.sessionId, 'Return a small fixture answer.')).stopReason, stopReason);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].body.max_completion_tokens ?? f.requests[0].body.max_tokens, cap);
    const history = await f.driver.history(f.sessionId);
    assert.equal(failures(history).length, 0);
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
    assert.equal(failures(history).length, 0, 'missing completion_tokens cannot establish output zero');
    assert.equal(summaries(history).length, 0);
    assert.equal(history.events.filter(event => event.type === 'compaction/start' || event.type === 'llm/retry').length, 0);
    assert.equal(history.events.at(-1).data.reason.kind, 'max-tokens');
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
  const systemId = history.events.find(event => event.type === 'system/message').data.message.id;
  const selectedInputIds = summaryFits.at(-1).messageIds.filter(id => id !== systemId);
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
  await assert.rejects(f.driver.prompt(f.sessionId, 'Continue the exact recorded task.'), { code: 'OUTPUT_TRUNCATED' });
  const summaryFits = fits.filter(item => item.purpose === 'compaction');
  assert.equal(summaryFits.length, 1);
  assert.equal(summaryFits[0].fit.effectiveMaxTokens, summaryFits[0].fit.desiredMaxTokens);
  assert.equal(f.requests.filter(request => request.summary).length, 1);
  assert.equal(modelCalls, 2);
  assert.equal(summaries(await f.driver.history(f.sessionId)).length, 0);
});
