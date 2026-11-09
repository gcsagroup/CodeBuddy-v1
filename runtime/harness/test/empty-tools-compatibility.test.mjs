import test from 'node:test';
import assert from 'node:assert/strict';
import '../sdk-budget-contract.mjs';
const { streamSimple } = await import('@earendil-works/pi-ai/api/openai-completions');

const rejection = "1 validation error:\n  {'type': 'value_error', 'loc': ('body',), 'msg': 'Value error, `tools` must not be an empty array. Either provide at least one tool or omit the field entirely.', 'input': {'tools': []}}";
const tool = { name: 'read', description: 'Read isolated fixture text', parameters: { type: 'object', properties: {} } };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = {
  id: 'fixture', name: 'fixture', provider: 'fixture', api: 'openai-completions', baseUrl: 'http://empty-tools.invalid/v1',
  input: ['text'], reasoning: false, contextWindow: 65536, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsDeveloperRole: false },
};
function history(available = false) {
  return { messages: [
    { role: 'system', content: 'Isolated protocol fixture', timestamp: 0, ...(available ? { toolsAdded: [tool] } : {}) },
    { role: 'user', content: 'Read one fixture receipt.', timestamp: 0 },
    { role: 'assistant', api: model.api, provider: model.provider, model: model.id, usage, stopReason: 'toolUse', timestamp: 0,
      content: [{ type: 'toolCall', id: 'fixture-call', name: 'read', arguments: {} }] },
    { role: 'toolResult', toolCallId: 'fixture-call', toolName: 'read', content: [{ type: 'text', text: 'COMPLETED_RECEIPT' }], isError: false, timestamp: 0 },
    { role: 'user', content: 'Use the completed receipt without calling another tool.', timestamp: 0 },
  ] };
}
const failure = (status, message = rejection) => new Response(JSON.stringify({ error: { type: 'Bad Request', code: status, message, param: null } }), {
  status, headers: { 'content-type': 'application/json', 'retry-after': '0' },
});
const success = () => new Response('data: '+JSON.stringify({ id: 'fixture-response', choices: [{ index: 0, delta: { content: 'RECEIPT_RETAINED' }, finish_reason: null }] })+'\n\n'+
  'data: '+JSON.stringify({ id: 'fixture-response', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })+'\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
async function run(handler, { available = false, maxRetries = 0, signal } = {}) {
  const context = history(available), before = structuredClone(context), requests = [];
  let payloads = 0, originalPayload;
  const result = await streamSimple(model, context, {
    apiKey: 'fixture-only', maxTokens: 128, maxRetries, maxRetryDelayMs: 1, signal,
    onPayload(payload) { payloads++; originalPayload = payload; },
    fetch: async (input, init) => {
      assert.equal(new URL(input).hostname, 'empty-tools.invalid', 'Never contact a real service');
      const body = JSON.parse(init.body);
      requests.push(body);
      return handler(body, requests.length);
    },
  }).result();
  assert.deepEqual(context, before, 'Compatibility cannot change persisted or replayed history');
  return { result, requests, payloads, originalPayload };
}

test('an explicit empty-tools rejection negotiates omission without changing tool history or invoking hooks twice', async () => {
  const f = await run((_body, attempt) => attempt === 1 ? failure(400) : success());
  assert.equal(f.result.stopReason, 'stop');
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[0].tools, []);
  assert.equal(Object.hasOwn(f.requests[1], 'tools'), false);
  const { tools: _empty, ...first } = f.requests[0];
  assert.deepEqual(f.requests[1], first, 'Only the rejected optional tools field may change');
  assert.ok(first.messages.some(message => message.tool_calls?.[0]?.id === 'fixture-call'));
  assert.ok(first.messages.some(message => message.role === 'tool' && message.content === 'COMPLETED_RECEIPT'));
  assert.equal(f.payloads, 1);
  assert.deepEqual(f.originalPayload.tools, [], 'Do not mutate a payload retained by an observer');
});

test('a proxy accepting empty tools retains the native one-request behavior', async () => {
  const f = await run(() => success());
  assert.equal(f.result.stopReason, 'stop');
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].tools, []);
});

test('the compatibility omission cannot repeat when the corrected request is also rejected', async () => {
  const f = await run(() => failure(400));
  assert.equal(f.result.stopReason, 'error');
  assert.equal(f.requests.length, 2);
  assert.equal(Object.hasOwn(f.requests[1], 'tools'), false);
});

for (const scenario of [
  { name: 'another parameter failure', status: 400, message: 'max_tokens must be positive' },
  { name: 'rate limiting', status: 429, message: rejection },
  { name: 'a quoted error in an unrelated request echo', status: 400, message: 'Different validation failed. User message echoed: '+rejection },
]) test(`empty-tools compatibility cannot reinterpret ${scenario.name}`, async () => {
  const f = await run(() => failure(scenario.status, scenario.message));
  assert.equal(f.result.stopReason, 'error');
  assert.equal(f.requests.length, 1);
});

test('nonempty tool declarations cannot be removed even if the service returns the empty-tools error', async () => {
  const f = await run(() => failure(400), { available: true });
  assert.equal(f.result.stopReason, 'error');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].tools.length, 1);
});

test('the corrected envelope still consumes the existing native transient retry policy', async () => {
  const f = await run((_body, attempt) => attempt === 1 ? failure(400) : attempt === 2 ? failure(503, 'Service temporarily unavailable') : success(), { maxRetries: 1 });
  assert.equal(f.result.stopReason, 'stop');
  assert.equal(f.requests.length, 3);
  assert.deepEqual(f.requests[0].tools, []);
  assert.ok(f.requests.slice(1).every(body => !Object.hasOwn(body, 'tools')));
});

test('cancellation after the validation response prevents a second network dispatch', async () => {
  const abort = new AbortController();
  const f = await run(() => { abort.abort(); return failure(400); }, { signal: abort.signal });
  assert.equal(f.result.stopReason, 'aborted');
  assert.equal(f.requests.length, 1);
});
