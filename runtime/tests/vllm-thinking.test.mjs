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
  assert.equal(calls.length, count + (backend === 'vllm' ? 11 : 10), 'Explicit refresh renews inventory, template probes and supported budget schema');
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
      const modes = { none: [1], low: [2], medium: [3], xhigh: [4] };
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
  for (const effort of [undefined, 'low', 'none']) {
    const configured = applyModelThinking(profile, modelThinkingPreference(thinkingProfile(provider, model), effort));
    const session = await driver.createSession({ cwd: root, provider: configured.provider, model, options: { thinkingEffort: configured.thinkingEffort } });
    assert.equal((await driver.prompt(session.sessionId, 'Reply OK.')).stopReason, 'end_turn');
    assert.equal(requests.at(-1).reasoning_effort, effort ?? 'xhigh');
    assert.equal(requests.at(-1).thinking_token_budget, backend !== 'vllm' || effort === 'none' ? undefined : effort === 'low' ? 1024 : 8192);
  }
});
}

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
  assert.equal(requests.at(-1).thinking_token_budget, 2048);
  assert.equal(requests.at(-1).chat_template_kwargs.enable_thinking, true);
  await driverProvider(provider, model);
  assert.equal(schemaReads, 1, 'Warm model reads must reuse the capability probe');
});
