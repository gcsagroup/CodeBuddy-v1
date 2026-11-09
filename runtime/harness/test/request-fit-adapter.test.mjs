import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { adapterPatch } from '../sdk-budget/adapter-patch.mjs';
import { estimateContextTokens } from '@earendil-works/pi-ai/utils/estimate';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { streamSimple as streamAnthropic } from '@earendil-works/pi-ai/api/anthropic-messages';
import { streamSimple as streamResponses } from '@earendil-works/pi-ai/api/openai-responses';

const nativeUrl = import.meta.resolve(adapterPatch.name);
const nativeSource = readFileSync(new URL(nativeUrl), 'utf8');
const hook = registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  if (url !== nativeUrl) return loaded;
  assert.equal(Buffer.from(loaded.source).toString('utf8'), nativeSource);
  return { ...loaded, source: adapterPatch.transform(nativeSource) };
} });
let PiAiAdapter;
try { ({ PiAiAdapter } = await import(adapterPatch.name)); }
finally { hook.deregister(); }

const messages = text => [{ role: 'user', content: [{ type: 'text', text }] }];
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };
const finish = chunks => chunks.findLast(chunk => chunk.type === 'finish');

function response(body, { stop = 'stop', output = 1, usage = { prompt_tokens: 11, completion_tokens: output, total_tokens: 11 + output }, usageInChoice = false } = {}) {
  const chunks = [];
  const emit = (delta, finish_reason = null, usage) => chunks.push(`data: ${JSON.stringify({
    id: 'fixture-response', model: body.model,
    choices: [{ index: 0, delta, finish_reason, ...(usage && usageInChoice ? { usage } : {}) }], ...(usage && !usageInChoice ? { usage } : {}),
  })}\n\n`);
  emit({ role: 'assistant', content: 'OK' });
  emit({}, stop, usage);
  return new Response(chunks.join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function fixture(t, { contextWindow = 65536, maxTokens = 32768, streamIdleTimeoutMs = 1000, attachments, handleFetch, api = 'openai-completions' } = {}) {
  const requests = [], transcripts = [];
  let authReads = 0;
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.hostname, 'request-fit.invalid', 'Tests must never dispatch to a real endpoint');
    const body = JSON.parse(typeof init.body === 'string' ? init.body : await input.clone().text());
    requests.push(body);
    return handleFetch ? handleFetch(body, init) : response(body);
  });
  const model = {
    id: 'fixture', name: 'fixture', provider: 'fixture', api,
    baseUrl: 'http://request-fit.invalid/v1', input: ['text', 'image'], reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens,
    compat: { supportsDeveloperRole: false, thinkingFormat: 'chat-template' },
  };
  const profile = {
    modelErrors: new Map(), configuredMaxTokens: new Map(), streamIdleTimeoutMs,
    piProvider: {
      id: 'fixture', name: 'fixture', getModels: () => [model],
      auth: { apiKey: { name: 'fixture', resolve: async () => ({ auth: {}, source: 'fixture' }) } },
      streamSimple: (resolved, context, options) => {
        transcripts.push(context);
        return (api === 'anthropic-messages' ? streamAnthropic : api === 'openai-responses' ? streamResponses : streamSimple)(resolved, context, options);
      },
    },
  };
  let profiles = new Map([['fixture', profile]]);
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => { authReads++; return 'fixture-only'; },
    auth: {
      credentials: { read: async () => undefined, list: async () => [], modify: async () => { throw Error('No credential writes'); } },
      authContext: { env: async () => undefined, fileExists: async () => false },
    },
    ...(attachments ? { resolveAttachments: () => attachments, resolveImageAccess: () => ({ readonlyPath: 'fixture-image.png' }) } : {}),
  });
  return {
    adapter, model, profile, requests, transcripts, authReads: () => authReads,
    replaceProfiles(next) { profiles = next; },
    options: extra => ({ provider: 'fixture', model: 'fixture', messages: messages('Reply OK'), ...extra }),
  };
}

test('request-fit patch rejects a different locked SDK source', () => {
  assert.throws(() => adapterPatch.transform(nativeSource + '\n'), /locked PiAiAdapter/);
});

test('prepared fit prices the normalized transcript used by actual HTTP dispatch', async t => {
  const f = fixture(t);
  const call = await f.adapter.prepareCall('fixture', 'fixture');
  const options = f.options({ system: 'A system prompt', tools: [{
    name: 'inspect', description: 'Inspect a file', parameters: { type: 'object', properties: {} },
  }] });
  const request = await call.prepareRequest(options);
  assert.equal(f.requests.length, 0);
  assert.equal(f.authReads(), 0, 'Fit needs no credential or HTTP request');
  assert.equal(request.fit.source, 'pi-ai-estimate-context-tokens');
  assert.equal(request.fit.desiredMaxTokens, 32768);
  assert.equal(request.fit.effectiveMaxTokens, 32768);
  assert.equal(request.fit.available, 65536 - request.fit.estimate.tokens - 4096);
  assert.ok(Object.isFrozen(request.fit));
  options.messages[0].content[0].text = 'Changed after projection';
  options.tools[0].parameters.properties.lateMutation = { type: 'string' };
  options.maxTokens = 1;
  const chunks = await collect(request.stream());
  assert.equal(finish(chunks).reason.kind, 'stop');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].max_completion_tokens, 32768);
  assert.equal(f.requests[0].messages.at(-1).content, 'Reply OK');
  assert.deepEqual(f.requests[0].tools[0].function.parameters.properties, {});
  assert.deepEqual(estimateContextTokens(f.transcripts[0]), request.fit.estimate);
  assert.equal(f.transcripts[0].messages.filter(message => message.role === 'system').length, 1);
  assert.equal(f.transcripts[0].messages[0].toolsAdded.length, 1);
  assert.equal(chunks.find(chunk => chunk.type === 'usage').usage.outputTokens, 1);
  assert.throws(() => request.stream(), error => error.code === 'REQUEST_ALREADY_CONSUMED');
});

test('one prepared request resolves one image version for fit and dispatch', async t => {
  let reads = 0, image = Buffer.from('first-request-version');
  const f = fixture(t, { attachments: { async readImageRequest() {
    reads++;
    return { data: image, bytes: image.length, mediaType: 'image/png', width: 2, height: 2 };
  } } });
  const call = await f.adapter.prepareCall('fixture', 'fixture');
  const request = await call.prepareRequest(f.options({ messages: [{ role: 'user', content: [{
    type: 'image', attachment: { attachmentId: 'sha256:fixture', mediaType: 'image/png', width: 2, height: 2 },
  }] }] }));
  image = Buffer.from('second-version-must-not-be-read');
  await collect(request.stream());
  assert.equal(reads, 1);
  assert.deepEqual(estimateContextTokens(f.transcripts[0]), request.fit.estimate);
  const content = f.requests[0].messages.at(-1).content;
  assert.equal(content.find(block => block.type === 'image_url').image_url.url, 'data:image/png;base64,' + Buffer.from('first-request-version').toString('base64'));
});

test('fit and dispatch retain native reasoning replay without injecting historical usage', async t => {
  const f = fixture(t);
  f.model.reasoning = true;
  const call = await f.adapter.prepareCall('fixture', 'fixture');
  const request = await call.prepareRequest(f.options({ messages: [
    ...messages('First turn'),
    { role: 'assistant', content: [{ type: 'reasoning', text: 'Preserved reasoning' }, { type: 'text', text: 'Previous answer' }],
      source: { provider: 'fixture', model: 'fixture', replayState: {
        response: { kind: 'pi-ai', version: 2, api: 'openai-completions', provider: 'fixture', model: 'fixture', stopReason: 'stop' },
        blocks: [{ type: 'reasoning', thinkingSignature: 'reasoning' }, { type: 'text' }],
      } } },
    ...messages('Next turn'),
  ] }));
  await collect(request.stream());
  const assistant = f.transcripts[0].messages.find(message => message.role === 'assistant');
  assert.equal(assistant.content[0].thinking, 'Preserved reasoning');
  assert.equal(assistant.usage.totalTokens, 0);
  assert.equal(request.fit.estimate.lastUsageIndex, null);
  const wireAssistant = f.requests[0].messages.find(message => message.role === 'assistant');
  assert.equal(wireAssistant.reasoning ?? wireAssistant.reasoning_content, 'Preserved reasoning');
  assert.deepEqual(estimateContextTokens(f.transcripts[0]), request.fit.estimate);
});

test('image projection keeps native cancellation classification before dispatch', async t => {
  const entered = Promise.withResolvers();
  const f = fixture(t, { attachments: { async readImageRequest(_ref, _target, signal) {
    entered.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } } });
  const call = await f.adapter.prepareCall('fixture', 'fixture');
  const controller = new AbortController();
  const pending = call.prepareRequest(f.options({ signal: controller.signal, messages: [{ role: 'user', content: [{
    type: 'image', attachment: { attachmentId: 'sha256:fixture', mediaType: 'image/png', width: 2, height: 2 },
  }] }] }));
  await entered.promise;
  controller.abort('cancel image preparation');
  await assert.rejects(pending, error => error.code === 'ABORTED');
  assert.equal(f.requests.length, 0);
});

test('local exhaustion prevents HTTP while a genuine one-token remainder is legal', async t => {
  for (const available of [-1, 0, 1, 2, 3]) {
    await t.test(`available ${available}`, async t => {
      const f = fixture(t);
      const call = await f.adapter.prepareCall('fixture', 'fixture');
      const tokens = 65536 - 4096 - available;
      const request = await call.prepareRequest(f.options({ messages: messages('x'.repeat(Math.floor(tokens * 3.5))) }));
      assert.equal(request.fit.available, available);
      if (available < 1) {
        await assert.rejects(collect(request.stream()), error => error.code === 'LOCAL_OUTPUT_BUDGET_EXHAUSTED' && error.failure.requestId === request.fit.requestId);
        assert.equal(f.requests.length, 0);
        assert.equal(f.authReads(), 0);
        await assert.rejects(collect(call.stream(f.options({ messages: messages('x'.repeat(Math.floor(tokens * 3.5))) }))), error => error.code === 'LOCAL_OUTPUT_BUDGET_EXHAUSTED');
      } else {
        await collect(request.stream());
        assert.equal(f.requests[0].max_completion_tokens, available);
      }
    });
  }
});

test('length classification retains raw reason and usage, without misclassifying explicit caps', async t => {
  for (const [cap, output, expected] of [[1, 1, 'error'], [128, 128, 'error'], [128, 1, 'error']]) {
    await t.test(`cap ${cap}, output ${output}`, async t => {
      const f = fixture(t, { handleFetch: body => response(body, { stop: 'length', output }) });
      const call = await f.adapter.prepareCall('fixture', 'fixture');
      const request = await call.prepareRequest(f.options({ maxTokens: cap }));
      const chunks = await collect(request.stream());
      const end = finish(chunks);
      assert.equal(end.reason.kind, expected);
      assert.equal(end.replayState.response.stopReason, 'length');
      assert.equal(chunks.find(chunk => chunk.type === 'usage').usage.outputTokens, output);
      if (expected === 'error') {
        assert.equal(end.reason.failure.code, output < cap ? 'OUTPUT_TRUNCATED' : 'OUTPUT_LIMIT_REACHED');
        assert.equal(end.reason.failure.requestId, request.fit.requestId);
      }
    });
  }
  await t.test('context-clamped one-token output keeps its unclamped desired cap', async t => {
    const f = fixture(t, { handleFetch: body => response(body, { stop: 'length', output: 1 }) });
    const call = await f.adapter.prepareCall('fixture', 'fixture');
    const request = await call.prepareRequest(f.options({ messages: messages('x'.repeat(Math.floor(61439 * 3.5))) }));
    assert.equal(request.fit.desiredMaxTokens, 32768);
    assert.equal(request.fit.effectiveMaxTokens, 1);
    const chunks = await collect(request.stream());
    assert.equal(f.requests[0].max_completion_tokens, 1);
    assert.equal(finish(chunks).reason.failure.code, 'OUTPUT_TRUNCATED');
  });
});

test('length requires explicitly reported output usage, including zero, before recovery classification', async t => {
  for (const [name, usage, kind, code, usageInChoice = false] of [
    ['absent usage', null, 'error', 'OUTPUT_LENGTH_STOP'],
    ['input-only usage', { prompt_tokens: 11 }, 'error', 'OUTPUT_LENGTH_STOP'],
    ['near-window input-only usage', { prompt_tokens: 65535 }, 'error', 'OUTPUT_LENGTH_STOP'],
    ['near-window explicit zero', { prompt_tokens: 65535, completion_tokens: 0 }, 'error', 'CONTEXT_WINDOW_EXCEEDED'],
    ['explicit zero', { prompt_tokens: 11, completion_tokens: 0 }, 'error', 'OUTPUT_TRUNCATED'],
    ['choice fallback zero', { prompt_tokens: 11, completion_tokens: 0 }, 'error', 'OUTPUT_TRUNCATED', true],
    ['choice fallback at cap', { prompt_tokens: 11, completion_tokens: 128 }, 'error', 'OUTPUT_LIMIT_REACHED', true],
  ]) {
    await t.test(name, async t => {
      const seen = [];
      const f = fixture(t, { handleFetch: body => response(body, { stop: 'length', usage, usageInChoice }) });
      const call = await f.adapter.prepareCall('fixture', 'fixture');
      const request = await call.prepareRequest(f.options({ maxTokens: 128, onProviderStreamEvent(event) { seen.push(event); } }));
      const chunks = await collect(request.stream());
      assert.equal(f.requests[0].max_completion_tokens, 128);
      assert.equal(finish(chunks).reason.kind, kind);
      assert.equal(finish(chunks).reason.failure?.code, code);
      assert.equal(finish(chunks).replayState.response.stopReason, 'length');
      assert.equal(chunks.find(chunk => chunk.type === 'usage').usage.outputTokens, usage?.completion_tokens ?? 0);
      assert.equal(seen.length, 2, 'an existing observer must remain in the same raw event chain');
    });
  }
});

test('reported output presence belongs to one dispatch and does not weaken non-length overflow checks', async t => {
  const f = fixture(t, { handleFetch: body => response(body, f.requests.length === 1
    ? { stop: 'length', output: 0 }
    : f.requests.length === 2 ? { stop: 'length', usage: null }
      : { stop: 'stop', usage: { prompt_tokens: 65537 } }) });
  const call = await f.adapter.prepareCall('fixture', 'fixture');
  const run = async () => collect((await call.prepareRequest(f.options({ maxTokens: 128 }))).stream());
  assert.equal(finish(await run()).reason.failure.code, 'OUTPUT_TRUNCATED');
  assert.equal(finish(await run()).reason.failure.code, 'OUTPUT_LENGTH_STOP');
  assert.equal(finish(await run()).reason.failure.code, 'CONTEXT_WINDOW_EXCEEDED');
});

test('Responses and Anthropic raw output counters distinguish missing final usage from explicit zero', async t => {
  for (const api of ['openai-responses', 'anthropic-messages']) for (const output of [undefined, 0, 128]) {
    await t.test(`${api}, output ${output}`, async t => {
      const f = fixture(t, { api, handleFetch: body => {
        const usage = output === undefined ? {} : { output_tokens: output };
        const item = { id: 'fixture-item', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
        const events = api === 'anthropic-messages' ? [
          { type: 'message_start', message: { id: 'fixture-message', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage },
          { type: 'message_stop' },
        ] : [
          { type: 'response.created', response: { id: 'fixture-response', status: 'in_progress', model: body.model, output: [] } },
          { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
          { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
          { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'OK' },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.incomplete', response: { id: 'fixture-response', model: body.model, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [item], usage: { input_tokens: 11, ...usage } } },
        ];
        return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
      } });
      const seen = [];
      const call = await f.adapter.prepareCall('fixture', 'fixture');
      const request = await call.prepareRequest(f.options({ maxTokens: 128, onProviderStreamEvent: event => seen.push(event.type) }));
      const chunks = await collect(request.stream());
      const end = finish(chunks);
      assert.equal(end.reason.kind, 'error');
      assert.equal(end.reason.failure?.code, output === 0 ? 'OUTPUT_TRUNCATED' : output === 128 ? 'OUTPUT_LIMIT_REACHED' : 'OUTPUT_LENGTH_STOP');
      assert.equal(chunks.find(chunk => chunk.type === 'usage').usage.outputTokens, output ?? 0);
      assert.ok(seen.includes(api === 'anthropic-messages' ? 'message_delta' : 'response.incomplete'));
    });
  }
});

test('server context overflow keeps its provider classification', async t => {
  const f = fixture(t, { handleFetch: () => new Response(JSON.stringify({
    error: { message: 'maximum context length exceeded', type: 'invalid_request_error', code: 'context_length_exceeded' },
  }), { status: 400, headers: { 'content-type': 'application/json' } }) });
  const call = await f.adapter.prepareCall('fixture', 'fixture');
  const chunks = await collect(call.stream(f.options()));
  assert.equal(f.requests.length, 1);
  assert.equal(finish(chunks).reason.failure.code, 'CONTEXT_WINDOW_EXCEEDED');
});

test('Responses minimum output budget is checked before its native wire floor can enlarge the cap', async t => {
  for (const [name, cap, available, expectedCap, code] of [
    ['explicit cap one', 1, undefined, undefined, 'INVALID_OUTPUT_BUDGET'],
    ['one token available', 128, 1, undefined, 'LOCAL_OUTPUT_BUDGET_EXHAUSTED'],
    ['15 tokens available', 128, 15, undefined, 'LOCAL_OUTPUT_BUDGET_EXHAUSTED'],
    ['16 tokens available', 128, 16, 16],
    ['17 tokens available', 128, 17, 17],
    ['explicit cap 128', 128, undefined, 128],
  ]) {
    await t.test(name, async t => {
      const f = fixture(t, { api: 'openai-responses', handleFetch: body => {
        const item = { id: 'fixture-item', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
        const events = [
          { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
          { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
          { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'OK' },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { id: 'fixture-response', model: body.model, status: 'completed', output: [item], usage: { input_tokens: 11, output_tokens: 1, total_tokens: 12 } } },
        ];
        return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
      } });
      const call = await f.adapter.prepareCall('fixture', 'fixture');
      const request = await call.prepareRequest(f.options({ maxTokens: cap, ...(available === undefined ? {} : {
        messages: messages('x'.repeat(Math.floor((65536 - 4096 - available) * 3.5))),
      }) }));
      assert.equal(request.fit.minimumMaxTokens, 16);
      assert.equal(request.fit.desiredMaxTokens, cap);
      assert.equal(request.fit.effectiveMaxTokens, available === undefined ? cap : Math.min(cap, available));
      if (code) {
        await assert.rejects(collect(request.stream()), error => error.code === code);
        assert.equal(f.requests.length, 0);
        assert.equal(f.authReads(), 0);
      } else {
        assert.equal(finish(await collect(request.stream())).reason.kind, 'stop');
        assert.equal(f.requests.length, 1);
        assert.equal(f.requests[0].max_output_tokens, expectedCap);
        assert.equal(f.requests[0].max_output_tokens, request.fit.effectiveMaxTokens);
      }
    });
  }
});

test('Responses supportsMaxOutputTokens false retains its native omitted-cap contract', async t => {
  const f = fixture(t, { api: 'openai-responses', handleFetch: body => new Response(`data: ${JSON.stringify({
    type: 'response.incomplete', response: { id: 'fixture-response', model: body.model, status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' }, output: [], usage: { input_tokens: 11, output_tokens: 1, total_tokens: 12 } },
  })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }) });
  f.model.compat.supportsMaxOutputTokens = false;
  const call = await f.adapter.prepareCall('fixture', 'fixture');
  const request = await call.prepareRequest(f.options({ maxTokens: 1 }));
  assert.equal(request.fit.minimumMaxTokens, 1);
  assert.equal(finish(await collect(request.stream())).reason.failure.code, 'OUTPUT_LENGTH_STOP');
  assert.equal(f.requests.length, 1);
  assert.equal(Object.hasOwn(f.requests[0], 'max_output_tokens'), false);
});

test('Anthropic thinking fit matches its final native wire cap', async t => {
  for (const [contextWindow, adaptive, desired, effective] of [
    [65536, false, 16512, 16512], [6000, false, 16512, 1901], [65536, true, 128, 128],
  ]) {
    await t.test(`window ${contextWindow}, adaptive ${adaptive}`, async t => {
      const f = fixture(t, { api: 'anthropic-messages', contextWindow, handleFetch: body => {
        const events = [
          ['message_start', { message: { id: 'fixture-message', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 0 } } }],
          ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
          ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'OK' } }],
          ['content_block_stop', { index: 0 }],
          ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
          ['message_stop', {}],
        ];
        return new Response(events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
      } });
      f.model.reasoning = true;
      f.model.compat = { forceAdaptiveThinking: adaptive };
      const call = await f.adapter.prepareCall('fixture', 'fixture');
      const request = await call.prepareRequest(f.options({ maxTokens: 128, reasoningEffort: 'high' }));
      assert.equal(request.fit.desiredMaxTokens, desired);
      assert.equal(request.fit.effectiveMaxTokens, effective);
      assert.equal(finish(await collect(request.stream())).reason.kind, 'stop');
      assert.equal(f.requests[0].max_tokens, request.fit.effectiveMaxTokens);
      assert.deepEqual(estimateContextTokens(f.transcripts[0]), request.fit.estimate);
    });
  }
});

test('prepared request retains its captured route when configuration changes', async t => {
  const f = fixture(t);
  const call = await f.adapter.prepareCall('fixture', 'fixture');
  f.replaceProfiles(new Map());
  const request = await call.prepareRequest(f.options());
  await collect(request.stream());
  assert.equal(f.requests.length, 1);
  assert.throws(() => f.adapter.prepareCall('fixture', 'fixture'), error => error.code === 'NO_ADAPTER');
});

test('caller cancellation takes priority over local exhaustion and remains connected during HTTP', async t => {
  const f = fixture(t, { handleFetch: (_body, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }) });
  const call = await f.adapter.prepareCall('fixture', 'fixture');
  const controller = new AbortController();
  const request = await call.prepareRequest(f.options({ signal: controller.signal }));
  const pending = collect(request.stream());
  while (!f.requests.length) await new Promise(resolve => setImmediate(resolve));
  controller.abort('fixture cancelled');
  assert.equal(finish(await pending).reason.kind, 'aborted');
  const exhaustedController = new AbortController();
  const exhausted = await call.prepareRequest(f.options({ signal: exhaustedController.signal, messages: messages('x'.repeat(65536 * 4)) }));
  exhaustedController.abort();
  await assert.rejects(collect(exhausted.stream()), error => error.code === 'ABORTED');
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(call.prepareRequest(f.options({ signal: cancelled.signal })), error => error.code === 'ABORTED');
  assert.equal(exhausted.fit.available < 1, true);
});

test('prepared stream keeps the native idle watchdog and upstream abort', { timeout: 3000 }, async t => {
  let upstreamAborted = false;
  const f = fixture(t, { streamIdleTimeoutMs: 20, handleFetch: (_body, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => { upstreamAborted = true; reject(options.signal.reason); }, { once: true });
  }) });
  const call = await f.adapter.prepareCall('fixture', 'fixture');
  const request = await call.prepareRequest(f.options());
  await assert.rejects(collect(request.stream()), error => error.code === 'TIMEOUT');
  assert.equal(upstreamAborted, true);
});
