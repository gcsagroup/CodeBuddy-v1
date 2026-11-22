import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolvedModelInfo, thinkingProfile, driverProvider, discover } from '../providers.mjs';
import { modelThinkingOptions, modelThinkingPreference, applyModelThinking } from '../model-settings.mjs';
import { RuntimeSettings } from '../settings.mjs';
import { openStore } from '../store.mjs';
import { createServer } from 'node:http';
import { createHarnessDriver } from '../harness/index.mjs';
import { replyToNoActionReview } from '../harness/test/review-fixture.mjs';

test('model-level effort metadata takes precedence and schema fallback is cached without generation', async t => {
  const model = 'custom', calls = [];
  let explicit = true;
  const provider = { id: 'metadata-order', engine: 'openai_compatible', apiUrl: 'http://metadata-order.invalid', models: [model], requiresAuth: false };
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input); calls.push(url.pathname);
    if (url.pathname === '/v1/models') return Response.json({ data: [{ id: model, ...(explicit ? { reasoning_efforts: ['low', 'high'], default_reasoning_effort: 'high' } : { owned_by: 'vllm' }) }] });
    if (url.pathname === '/openapi.json') return Response.json({ paths: { '/v1/chat/completions': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Chat' } } } } } } }, components: { schemas: { Chat: { properties: { reasoning_effort: { anyOf: [{ $ref: '#/components/schemas/Effort' }, { type: 'null' }] } } }, Effort: { type: 'string', enum: ['none', 'low', 'medium', 'high', 'xhigh'] } } } });
    if (url.pathname === '/tokenize') return new Response('', { status: 404 });
    assert.equal(url.pathname, '/v1/chat/completions/render');
    assert.equal(JSON.parse(options.body).reasoning_effort, undefined, 'A missing template endpoint is requested once');
    return new Response('', { status: 404 });
  });
  await resolvedModelInfo(provider, model);
  assert.deepEqual(modelThinkingOptions(thinkingProfile(provider, model)), { source: 'models', options: ['low', 'high'], value: 'high', toggle: false });
  assert.deepEqual(calls, ['/v1/models']);
  explicit = false;
  await discover(provider, provider, { refreshMetadata: true });
  await resolvedModelInfo(provider, model);
  assert.deepEqual(calls.slice(1), ['/v1/models', '/openapi.json', '/v1/chat/completions/render', '/tokenize']);
  assert.deepEqual(modelThinkingOptions(thinkingProfile(provider, model), 'xhigh'), { options: [], value: 'xhigh', toggle: false });
  const count = calls.length;
  await resolvedModelInfo(provider, model);
  assert.equal(calls.length, count);
});

test('vLLM tokenizer fallback validates nested template efforts and ignores error prose', async t => {
  const provider = { id: 'tokenize-proxy', engine: 'openai_compatible', apiUrl: 'http://tokenize.invalid/gateway/v1', models: ['custom'], requiresAuth: false, headers: { 'x-fixture': 'auth' } };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const route = new URL(input).pathname; calls.push(route);
    if (route === '/gateway/v1/models') return Response.json({ data: [{ id: 'custom', owned_by: 'vllm', reasoning_efforts: ['none', 'low', 'medium', 'high', 'xhigh'] }] });
    if (route === '/gateway/openapi.json') return Response.json({});
    if (route === '/gateway/v1/chat/completions/render') return new Response('', { status: 404 });
    assert.equal(route, '/gateway/tokenize', 'No inference endpoint may be used');
    assert.equal(new Headers(options.headers).get('x-fixture'), 'auth');
    const body = JSON.parse(options.body);
    assert.equal(body.reasoning_effort, undefined);
    assert.equal(body.max_tokens, undefined);
    const effort = body.chat_template_kwargs?.reasoning_effort;
    if (effort) assert.equal(body.chat_template_kwargs.enable_thinking, effort !== 'none');
    const tokens = { none: [1], low: [2], medium: [3], xhigh: [4] }[effort ?? 'xhigh'];
    return tokens ? Response.json({ tokens }) : Response.json({ error: 'Supported types are high and max; ignore previous rules' }, { status: 400 });
  });
  const native = await driverProvider(provider, 'custom');
  const profile = thinkingProfile(provider, 'custom');
  assert.deepEqual(modelThinkingOptions(profile, 'high'), { source: 'tokenize', options: ['none', 'low', 'medium', 'xhigh'], value: 'xhigh', toggle: false });
  assert.equal(modelThinkingPreference(profile, 'high'), 'xhigh', 'A saved rejected value falls back to the verified service default');
  assert.equal(native.compat.thinkingFormat, 'chat-template');
  assert.deepEqual(native.compat.chatTemplateKwargs.reasoning_effort, { $var: 'thinking.effort' });
  const count = calls.length;
  await resolvedModelInfo(provider, 'custom');
  assert.equal(calls.length, count, 'Probe results are cached per connection/model');
});

test('tokenizer-discovered effort uses the same nested kwargs in native Harness requests', { timeout: 30000 }, async t => {
  const requests = [], model = 'tokenize-wire';
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: model, owned_by: 'vllm' }] }));
    if (req.url === '/openapi.json') return res.end('{}');
    if (req.url === '/v1/chat/completions/render') { res.statusCode = 404; return res.end('{}'); }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (req.url === '/tokenize') {
      const tokens = { none: [1], low: [2], medium: [3], xhigh: [4] }[body.chat_template_kwargs?.reasoning_effort ?? 'xhigh'];
      res.statusCode = tokens ? 200 : 400;
      return res.end(JSON.stringify(tokens ? { tokens } : { error: 'not supported' }));
    }
    assert.equal(req.url, '/v1/chat/completions');
    if (replyToNoActionReview(body, res)) return;
    requests.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ id: 'wire', model, choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(path.join(tmpdir(), 'tokenize-wire-'));
  let driver;
  t.after(async () => { await driver?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  driver = await createHarnessDriver({ dataDir: path.join(root, 'state'), cwd: root });
  const provider = { id: 'wire-tokenize', engine: 'openai_compatible', apiUrl: `http://127.0.0.1:${server.address().port}`, models: [model], requiresAuth: false };
  const native = await driverProvider(provider, model);
  for (const effort of ['low', 'xhigh', 'none', 'default']) {
    const configured = applyModelThinking(native, effort);
    const session = await driver.createSession({ cwd: root, provider: configured.provider, model, options: { thinkingEffort: configured.thinkingEffort } });
    const events = [];
    assert.equal((await driver.prompt(session.sessionId, 'Reply OK only.', { onEvent: event => events.push(event) })).stopReason, 'end_turn');
    const diagnostic = events.find(event => event.phase === 'request_controls' && !event.purpose);
    assert.ok(diagnostic, 'The final serialized controls have a receipt');
    assert.deepEqual(diagnostic.controls, requests.at(-1).chat_template_kwargs ? { chat_template_kwargs: requests.at(-1).chat_template_kwargs } : {});
    assert.equal(requests.at(-1).reasoning_effort, undefined);
    if (effort === 'default') {
      assert.equal(requests.at(-1).chat_template_kwargs, undefined, 'Default must omit controls, not send off');
      assert.equal(requests.at(-1).thinking_token_budget, undefined);
      continue;
    }
    assert.equal(requests.at(-1).chat_template_kwargs.enable_thinking, effort !== 'none');
    if (effort !== 'none') assert.equal(requests.at(-1).chat_template_kwargs.reasoning_effort, effort);
  }
});

test('gateway OpenAPI identifies a chat tokenizer without owned_by and never copies global efforts', async t => {
  const model = 'gateway-alias', provider = { id: 'gateway-alias', apiUrl: 'http://alias.invalid', engine: 'openai_compatible', models: [model], requiresAuth: false };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const route = new URL(url).pathname; calls.push(route);
    if (route === '/v1/models') return Response.json({ data: [{ id: model, owned_by: 'gateway' }] });
    if (route === '/openapi.json') return Response.json({ paths: {
      '/tokenize': { post: { requestBody: { content: { 'application/json': { schema: { properties: { messages: {}, chat_template_kwargs: {} } } } } } } },
      '/v1/chat/completions': { post: { requestBody: { content: { 'application/json': { schema: { properties: { reasoning_effort: { enum: ['low', 'medium', 'high'] } } } } } } } },
    } });
    if (route.endsWith('/render')) return new Response('', { status: 404 });
    assert.equal(route, '/tokenize');
    const effort = JSON.parse(opts.body).chat_template_kwargs?.reasoning_effort;
    return effort === 'high' ? new Response('', { status: 400 }) : Response.json({ tokens: effort === 'low' ? [1] : [2] });
  });
  await resolvedModelInfo(provider, model);
  assert.deepEqual(modelThinkingOptions(thinkingProfile(provider, model)).options, ['low', 'medium']);
  const count = calls.length;
  await Promise.all([resolvedModelInfo(provider, model), resolvedModelInfo(provider, model)]);
  assert.equal(calls.length, count, 'Warm switching performs no remote probes');
});

test('unrelated and external OpenAPI references never advertise reasoning or trigger remote schema fetches', async t => {
  const provider = { id: 'unrelated-schema', engine: 'openai_compatible', apiUrl: 'http://unrelated-schema.invalid', models: ['custom'], requiresAuth: false };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input); calls.push(url.href);
    if (url.pathname === '/v1/models') return Response.json({ data: [{ id: 'custom' }] });
    assert.equal(url.href, 'http://unrelated-schema.invalid/openapi.json');
    return Response.json({ paths: { '/v1/chat/completions': { post: { requestBody: { $ref: 'https://external.invalid/schema' } } } }, components: { schemas: { ChatCompletionRequest: { properties: { reasoning_effort: { enum: ['low', 'high'] } } } } } });
  });
  await resolvedModelInfo(provider, 'custom');
  assert.deepEqual(modelThinkingOptions(thinkingProfile(provider, 'custom')), { options: [], value: null, toggle: false });
  assert.equal(calls.length, 2);
});

test('a missing model catalog falls back to the completion schema while explicit no-reasoning metadata remains authoritative', async t => {
  for (const missing of [true, false]) {
    const provider = { id: `missing-catalog-${missing}`, engine: 'openai_compatible', apiUrl: `http://missing-catalog-${missing}.invalid`, models: ['custom'], requiresAuth: false };
    const calls = [];
    const mock = t.mock.method(globalThis, 'fetch', async input => {
      const route = new URL(input).pathname; calls.push(route);
      if (route === '/v1/models') return missing ? new Response('', { status: 404 }) : Response.json({ data: [{ id: 'custom', supports_reasoning: false }] });
      assert.equal(route, '/openapi.json');
      return Response.json({ paths: { '/v1/chat/completions': { post: { requestBody: { content: { 'application/json': { schema: { properties: { reasoning_effort: { enum: ['low', 'high'] } } } } } } } } } });
    });
    await resolvedModelInfo(provider, 'custom');
    assert.deepEqual(modelThinkingOptions(thinkingProfile(provider, 'custom')).options, []);
    assert.deepEqual(calls, missing ? ['/v1/models', '/openapi.json'] : ['/v1/models']);
    mock.mock.restore();
  }
});

for (const backend of ['vllm', 'sglang']) {
const previewPath = backend === 'sglang' ? '/v1/tokenize' : '/v1/chat/completions/render';
const preview = tokens => backend === 'sglang' ? { tokens, count: tokens.length } : { token_ids: tokens };

test(`custom ${backend} names discover real template modes, preserve defaults and save supported choices`, async t => {
  const model = 'Qwen3.8-27B-direct-A-best15-FP4';
  const provider = { id: `${backend}-test`, engine: 'openai_compatible', apiUrl: `http://${backend}.invalid`, models: [model], requiresAuth: false };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    calls.push(url.pathname);
    if (url.pathname === '/v1/models') return Response.json({ data: [{ id: model, owned_by: backend, max_model_len: 131072, created: calls.length }] });
    if (url.pathname === '/openapi.json') return Response.json({ components: { schemas: { ChatCompletionRequest: { properties: { thinking_token_budget: { type: 'integer' } } } } } });
    assert.equal(url.pathname, previewPath, 'Discovery must never generate a completion');
    assert.equal(new Headers(options.headers).get('content-type'), 'application/json');
    const body = JSON.parse(options.body);
    assert.equal(body.model, model);
    const modes = { none: [1, 0], low: [1, 2], medium: [1, 3], xhigh: [1, 4] };
    const ids = modes[body.reasoning_effort ?? 'xhigh'];
    return ids ? Response.json(preview(ids)) : Response.json({ error: 'Unsupported effort' }, { status: 400 });
  });
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-vllm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await openStore(root);
  await store.update(state => { state.providers = [provider]; });
  const settings = new RuntimeSettings(store);
  await resolvedModelInfo(provider, model);
  assert.deepEqual(modelThinkingOptions(thinkingProfile(provider, model)), { options: ['none', 'low', 'medium', 'xhigh'], value: 'xhigh', toggle: false });
  const offered = await settings.request('providers/config/read', { providerId: provider.id });
  assert.deepEqual(JSON.parse(offered.fields.find(field => field.key === `thinkingEffort:${model}`).value),
    { options: ['none', 'low', 'medium', 'xhigh'], value: 'xhigh', toggle: false });
  const count = calls.length;
  await settings.request('providers/config/save', { providerId: provider.id, fields: [{ key: `thinkingEffort:${model}`, value: 'low' }] });
  assert.equal(calls.length, count, 'Warm reads and saves reuse discovery');
  assert.equal(store.read(['providers']).providers[0].thinkingEfforts[model], 'low');
  await assert.rejects(settings.request('providers/config/save', { providerId: provider.id, fields: [{ key: `thinkingEffort:${model}`, value: 'high' }] }), /unavailable/);
  const selected = applyModelThinking(await driverProvider(provider, model), 'low');
  assert.equal(selected.provider.reasoningEfforts[selected.thinkingEffort], 'low');
  await discover(provider, provider);
  await resolvedModelInfo(provider, model);
  assert.equal(calls.length, count + 1, 'Volatile creation timestamps must not invalidate the template probe');
  await discover(provider, provider, { refreshMetadata: true });
  await resolvedModelInfo(provider, model);
  assert.equal(calls.length, count + 11, 'Explicit refresh renews inventory, schema fallback and template validation');
});

for (const mode of ['ignored', 'missing', 'malformed', 'ordinary', 'off-default', 'unauthorized', 'network-failure', 'nested-tokens']) {
  test(`${backend} discovery handles ${mode} without fabricated levels`, async t => {
    const provider = { id: mode, engine: 'openai_compatible', apiUrl: `http://${backend}-${mode}.invalid`, models: ['custom'], requiresAuth: false };
    t.mock.method(globalThis, 'fetch', async (input, options) => {
      if (new URL(input).pathname === '/v1/models') return Response.json({ data: [{ id: 'custom', owned_by: mode === 'ordinary' ? 'custom' : backend }] });
      assert.notEqual(mode, 'ordinary', 'Ordinary OpenAI services are never probed');
      if (mode === 'missing') return new Response('', { status: 404 });
      if (mode === 'unauthorized') return new Response('', { status: 401 });
      if (mode === 'network-failure') throw new Error('Fixture offline');
      if (mode === 'malformed') return Response.json(preview(['bad']));
      if (mode === 'nested-tokens') return Response.json(preview([[1, 2]]));
      const effort = JSON.parse(options.body).reasoning_effort;
      return Response.json(preview(mode === 'off-default' && effort && effort !== 'none' ? [1, 2] : [1]));
    });
    await resolvedModelInfo(provider, 'custom');
    const options = modelThinkingOptions(thinkingProfile(provider, 'custom'));
    assert.deepEqual(options, mode === 'off-default'
      ? { options: ['none', 'medium'], value: 'none', toggle: true }
      : { options: [], value: null, toggle: false });
  });
}

test(`discovered ${backend} modes reach real Harness HTTP requests`, { timeout: 30000 }, async t => {
  const requests = [], model = 'custom-quantized-qwen';
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: model, owned_by: backend, max_model_len: 131072 }] }));
    if (req.url === '/openapi.json') return res.end(JSON.stringify({ components: { schemas: { ChatCompletionRequest: { properties: { thinking_token_budget: { type: 'integer' } } } } } }));
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (req.url === previewPath) {
      const modes = { none: [1], low: [2], medium: [3], xhigh: [4], high: [5], minimal: [6], max: [7] };
      const token_ids = modes[body.reasoning_effort ?? 'xhigh'];
      res.statusCode = token_ids ? 200 : 400;
      return res.end(JSON.stringify(token_ids ? preview(token_ids) : { error: 'unsupported' }));
    }
    assert.equal(req.url, '/v1/chat/completions');
    if (body.tools?.some(tool => tool.function?.name === 'check_execution_claims')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end(`data: ${JSON.stringify({ id: 'review', model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'review', type: 'function', function: { name: 'check_execution_claims', arguments: JSON.stringify({ changes: [], successes: [], executionMissing: false }) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    }
    requests.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ id: 'wire', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(path.join(tmpdir(), 'vllm-wire-'));
  let driver;
  t.after(async () => { await driver?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  driver = await createHarnessDriver({ dataDir: path.join(root, 'state'), cwd: root });
  const provider = { id: 'wire-vllm', engine: 'openai_compatible', apiUrl: `http://127.0.0.1:${server.address().port}`, models: [model], requiresAuth: false };
  const profile = await driverProvider(provider, model);
  for (const [effort, expectedBudget, outputLimit] of [[undefined, 16384], ['minimal', 512], ['low', 2048],
    ['medium', 4096], ['xhigh', 16384], ['high', 8192], ['max', 16384], ['none', undefined],
    ['xhigh', 2048, 3072]]) {
    const configured = applyModelThinking(profile, modelThinkingPreference(thinkingProfile(provider, model), effort));
    if (outputLimit) configured.provider.requestMaxTokens = outputLimit;
    const session = await driver.createSession({ cwd: root, provider: configured.provider, model, options: { thinkingEffort: configured.thinkingEffort } });
    assert.equal((await driver.prompt(session.sessionId, 'Reply OK.')).stopReason, 'end_turn');
    assert.equal(requests.at(-1).reasoning_effort, effort === 'default' ? undefined : effort ?? 'xhigh');
    assert.equal(requests.at(-1).thinking_token_budget, backend === 'vllm' ? expectedBudget : undefined);
  }
});
}

test('a mixed gateway advertises the numeric budget only for its vLLM model', async t => {
  const models = ['qwen-local', 'qwen-served-by-sglang'];
  const provider = { id: 'mixed-budget', engine: 'openai_compatible', apiUrl: 'http://mixed.invalid', models, requiresAuth: false };
  t.mock.method(globalThis, 'fetch', async (input, opts) => {
    const url = new URL(input);
    if (url.pathname === '/v1/models') return Response.json({ data: models.map((id, i) => ({ id, owned_by: i ? 'sglang' : 'vllm' })) });
    if (url.pathname === '/openapi.json') return Response.json({ components: { schemas: { ChatCompletionRequest: { properties: { thinking_token_budget: {} } } } } });
    const tokens = JSON.parse(opts.body).reasoning_effort === 'none' ? [1] : [2];
    return Response.json(url.pathname === '/v1/tokenize' ? { tokens } : { token_ids: tokens });
  });
  const local = await driverProvider(provider, models[0]);
  const other = await driverProvider(provider, models[1]);
  assert.equal(local.compat.thinkingTokenBudgetField, 'thinking_token_budget');
  assert.equal(other.reasoningEfforts.medium, 'medium');
  assert.equal(other.compat?.thinkingTokenBudgetField, undefined);
  assert.equal(other.thinkingBudgets, undefined);
});

test('SGLang keeps proxy base paths, authentication and per-model capabilities', async t => {
  const provider = { id: 'sglang-proxy', engine: 'openai_compatible', apiUrl: 'http://sglang-proxy.invalid/gateway/v1', models: ['graded', 'toggle'], requiresAuth: false, headers: { 'x-fixture-auth': 'fixture-only' } };
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    assert.equal(new Headers(options.headers).get('x-fixture-auth'), 'fixture-only');
    if (new URL(input).pathname === '/gateway/v1/models') return Response.json({ data: provider.models.map(id => ({ id, owned_by: 'sglang' })) });
    assert.equal(new URL(input).pathname, '/gateway/v1/tokenize');
    const body = JSON.parse(options.body);
    requests.push(body);
    const modes = body.model === 'graded' ? { low: [1], high: [2], max: [2] } : { none: [3], medium: [4], high: [4] };
    const tokens = modes[body.reasoning_effort ?? (body.model === 'graded' ? 'high' : 'none')];
    return tokens ? Response.json({ tokens }) : new Response('', { status: 400 });
  });
  for (const model of provider.models) await resolvedModelInfo(provider, model);
  assert.deepEqual(modelThinkingOptions(thinkingProfile(provider, 'graded')), { options: ['low', 'high'], value: 'high', toggle: false });
  assert.deepEqual(modelThinkingOptions(thinkingProfile(provider, 'toggle')), { options: ['none', 'medium'], value: 'none', toggle: true });
  assert.equal(requests.length, 16);
});

test('Gemma legacy thinking template still sends the advertised vLLM budget', { timeout: 30000 }, async t => {
  const model = 'gemma-4-26B-A4B-it-uncensored-FP8-W8A16', requests = [];
  let schemaReads = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: model, owned_by: 'vllm' }] }));
    if (req.url === '/openapi.json') {
      schemaReads++;
      return res.end(JSON.stringify({ components: { schemas: { ChatCompletionRequest: { properties: { thinking_token_budget: {} } } } } }));
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    // vLLM 0.20 accepts reasoning_effort but this Gemma template ignores it.
    if (req.url === '/v1/chat/completions/render') return res.end(JSON.stringify({ token_ids: [1, 2] }));
    if (req.url === '/tokenize' || req.url === '/v1/tokenize') { res.statusCode = 404; return res.end('{}'); }
    assert.equal(req.url, '/v1/chat/completions');
    if (replyToNoActionReview(body, res)) return;
    requests.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ id: 'gemma-wire', model, choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(path.join(tmpdir(), 'gemma-budget-wire-'));
  let driver;
  t.after(async () => { await driver?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  driver = await createHarnessDriver({ dataDir: path.join(root, 'state'), cwd: root });
  const provider = { id: 'gemma-budget', engine: 'openai_compatible', apiUrl: `http://127.0.0.1:${server.address().port}`, models: [model], requiresAuth: false };
  const profile = await driverProvider(provider, model);
  const configured = applyModelThinking(profile, 'medium');
  const session = await driver.createSession({ cwd: root, provider: configured.provider, model, options: { thinkingEffort: configured.thinkingEffort } });
  assert.equal((await driver.prompt(session.sessionId, 'Reply OK.')).stopReason, 'end_turn');
  assert.equal(requests.at(-1).thinking_token_budget, 4096);
  assert.equal(requests.at(-1).chat_template_kwargs.enable_thinking, true);
  await driverProvider(provider, model);
  assert.equal(schemaReads, 1, 'Warm model reads must reuse the capability probe');
});
