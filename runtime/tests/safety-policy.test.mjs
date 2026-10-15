import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SafetyPolicy } from '../safety-policy.mjs';
import { protectSecret } from '../secrets.mjs';

const labels = score => [[{ label: 'INJECTION', score }, { label: 'SAFE', score: 1 - score }]];
const tool = command => ({ id: 'fixture-call', name: 'pwsh', arguments: { command, description: 'isolated classifier fixture' } });
async function fixture(t, options = {}) {
  const requests = [];
  let respond = ({ request }) => labels(request.url === '/prompt' ? 0.9 : 0.1);
  const server = http.createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    const entry = { url: request.url, body: JSON.parse(raw), authorization: request.headers.authorization };
    requests.push(entry);
    const result = await respond({ request, response, entry });
    if (!response.writableEnded && result !== undefined) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = {
    SECURITY_PROMPT_ENABLED: { value: true },
    SECURITY_COMMAND_CLASSIFIER_ENABLED: { value: true },
    SECURITY_COMMAND_CLASSIFIER_ENDPOINT: { value: base + '/command' },
  };
  const store = { read: () => ({ config: structuredClone(config) }) };
  const policy = new SafetyPolicy(store, options);
  return { base, config, policy, requests, store, setResponse(fn) { respond = fn; } };
}

test('disabled or non-shell detection performs no external requests and missing detection is never reported clean', async t => {
  const { config, policy, requests } = await fixture(t);
  config.SECURITY_PROMPT_ENABLED.value = false;
  assert.equal((await policy.inspect({ tool: tool('echo fixture'), userMessages: ['PRIVATE_USER_TEXT'] })).status, 'disabled');
  config.SECURITY_PROMPT_ENABLED.value = true;
  for (const name of ['read', 'write', 'codebuddy_task', 'mcp__external__shell']) assert.equal((await policy.inspect({ tool: { name }, userMessages: ['PRIVATE_USER_TEXT'] })).status, 'not_applicable');
  config.SECURITY_COMMAND_CLASSIFIER_ENABLED.value = false;
  const missing = await policy.inspect({ tool: tool('echo fixture') });
  assert.equal(missing.status, 'unavailable'); assert.equal(missing.requiresApproval, true);
  assert.equal(missing.confidence, null);
  assert.ok(missing.reasonCodes.includes('command_classifier_disabled'));
  assert.equal(requests.length, 0);
});

test('original endpoint and protected token settings affect real HTTP calls and never replace existing permission', async t => {
  const { config, policy, requests, setResponse } = await fixture(t);
  const token = 'isolated-classifier-token';
  config.SECURITY_COMMAND_CLASSIFIER_TOKEN = { secret: await protectSecret(token) };
  const command = 'Write-Output "quoted rm -rf / is fixture text"';
  const clear = await policy.inspect({ tool: tool(command), userMessages: ['DO_NOT_SEND_PROMPT_WHEN_DISABLED'] });
  assert.equal(clear.status, 'clear'); assert.equal(clear.requiresApproval, false);
  assert.deepEqual(requests[0].body, { inputs: command });
  assert.equal(requests[0].authorization, `Bearer ${token}`);
  assert.equal(requests.some(row => JSON.stringify(row.body).includes('DO_NOT_SEND_PROMPT_WHEN_DISABLED')), false);
  setResponse(() => labels(0.9));
  const flagged = await policy.inspect({ tool: tool('echo fixture') });
  assert.equal(flagged.status, 'flagged'); assert.equal(flagged.requiresApproval, true);
  assert.match(flagged.findingId, /^SEC-/);
  assert.equal(JSON.stringify(flagged).includes(token), false);
  config.SECURITY_PROMPT_THRESHOLD = { value: 0.9 };
  assert.equal((await policy.inspect({ tool: tool('echo fixture') })).status, 'clear', 'preserve the existing strict above-threshold approval boundary');
  config.SECURITY_PROMPT_ENABLED.value = false;
  const count = requests.length;
  assert.equal((await policy.inspect({ tool: tool('echo fixture') })).status, 'disabled');
  assert.equal(requests.length, count, 'turning detection off immediately stops classifier requests');
});

test('prompt scoring sends only the supplied last ten user texts to its explicitly enabled endpoint', async t => {
  const { base, config, policy, requests, setResponse } = await fixture(t);
  config.SECURITY_PROMPT_CLASSIFIER_ENABLED = { value: true };
  config.SECURITY_PROMPT_CLASSIFIER_ENDPOINT = { value: base + '/prompt' };
  config.SECURITY_PROMPT_THRESHOLD = { value: 0.55 };
  setResponse(({ request }) => labels(request.url === '/prompt' ? 0.9 : 0.5));
  const texts = Array.from({ length: 12 }, (_, index) => `USER_MESSAGE_${index}`);
  const result = await policy.inspect({ tool: tool('echo fixture'), userMessages: texts });
  assert.equal(result.status, 'flagged');
  assert.ok(Math.abs(result.confidence - 0.58) < 1e-9);
  assert.deepEqual(requests.filter(row => row.url === '/prompt').map(row => row.body.inputs).sort(), texts.slice(-10).sort());
  assert.equal(result.coverage.prompt.succeeded, 10);
  setResponse(({ request }) => labels(request.url === '/prompt' ? 0.99 : 0.1));
  assert.equal((await policy.inspect({ tool: tool('echo fixture'), userMessages: texts })).status, 'clear', 'retain original command-primary combination rather than creating a second semantic judge');
  config.SECURITY_PROMPT_CLASSIFIER_ENABLED.value = false;
  const before = requests.filter(row => row.url === '/prompt').length;
  await policy.inspect({ tool: tool('echo fixture'), userMessages: ['NO_EXTERNAL_PROMPT'] });
  assert.equal(requests.filter(row => row.url === '/prompt').length, before);
});

test('explicit organization model mappings and overrides use the original classifier payload', async t => {
  const { base, config, requests, store } = await fixture(t);
  config.SECURITY_PROMPT_ENABLED.value = false;
  config.SECURITY_COMMAND_CLASSIFIER_ENABLED.value = false;
  delete config.SECURITY_COMMAND_CLASSIFIER_ENDPOINT;
  config.SECURITY_PROMPT_CLASSIFIER_ENABLED = { value: true };
  config.SECURITY_PROMPT_CLASSIFIER_MODEL = { value: 'prompt-guard' };
  const policy = new SafetyPolicy(store, { modelMapping: JSON.stringify({
    'command-guard': { endpoint: base + '/command', model_type: 'command', function_to_apply: 'softmax' },
    'prompt-guard': { endpoint: base + '/prompt', model_type: 'prompt', top_k: 2 },
  }), overrides: { promptEnabled: 'true', commandEnabled: 'true' } });
  await policy.inspect({ tool: tool('echo fixture'), userMessages: ['provided user context'] });
  assert.deepEqual(requests.find(row => row.url === '/command').body.parameters, { function_to_apply: 'softmax' });
  assert.deepEqual(requests.find(row => row.url === '/prompt').body.parameters, { top_k: 2 });
  assert.ok(requests.every(row => !row.authorization));
  config.SECURITY_PROMPT_CLASSIFIER_MODEL.value = 'missing-guard';
  const result = await policy.inspect({ tool: tool('echo fixture'), userMessages: ['context'] });
  assert.equal(result.status, 'unavailable');
  assert.ok(result.reasonCodes.includes('classifier_not_configured'));
});

test('UTF-8 command windows cover the input and a bounded unscanned tail escalates instead of fabricating confidence', async t => {
  const { policy, requests } = await fixture(t);
  const unicode = '😀'.repeat(250);
  const result = await policy.inspect({ tool: tool(unicode) });
  assert.equal(result.status, 'clear'); assert.equal(result.coverage.command.complete, true);
  assert.ok(requests.length > 1);
  assert.ok(requests.every(row => Buffer.byteLength(row.body.inputs) <= 500 && !row.body.inputs.includes('\uFFFD')));
  assert.equal(requests[0].body.inputs, '😀'.repeat(125));
  const count = requests.length;
  const huge = await policy.inspect({ tool: tool('x'.repeat(10_000)) });
  assert.equal(requests.length - count, 12);
  assert.equal(huge.status, 'unavailable'); assert.equal(huge.requiresApproval, true);
  assert.ok(huge.reasonCodes.includes('command_scan_incomplete'));
  assert.ok(huge.confidence < 0.2, 'unknown coverage is not turned into a fabricated malicious score');
});

test('partial failures, malformed labels, response bounds, redirects and timeouts never become clean scans', async t => {
  const { base, config, store, policy, requests, setResponse } = await fixture(t);
  let count = 0;
  setResponse(({ response }) => { if (++count === 1) { response.writeHead(503); response.end('DO_NOT_ECHO_SERVER_SECRET'); return; } return labels(0.1); });
  const partial = await policy.inspect({ tool: tool('a'.repeat(900)) });
  assert.equal(partial.status, 'unavailable'); assert.equal(partial.coverage.command.failed, 1);
  assert.equal(JSON.stringify(partial).includes('DO_NOT_ECHO_SERVER_SECRET'), false);
  for (const data of [[], { safe: true }, [[{ label: 'UNRECOGNIZED', score: 1 }]], [[{ label: 'INJECTION', score: '0.9' }]], [[{ label: 'SAFE', score: 0.5 }, { label: 'LABEL_0', score: 0.5 }]]]) {
    setResponse(() => data);
    assert.equal((await policy.inspect({ tool: tool('echo fixture') })).status, 'unavailable');
  }
  setResponse(() => 'x'.repeat(70_000));
  assert.ok((await policy.inspect({ tool: tool('echo fixture') })).reasonCodes.includes('classifier_response_too_large'));
  setResponse(({ response }) => { response.writeHead(302, { location: base + '/unexpected-target' }); response.end(); });
  assert.equal((await policy.inspect({ tool: tool('echo fixture') })).status, 'unavailable');
  assert.equal(requests.some(row => row.url === '/unexpected-target'), false);
  setResponse(() => undefined);
  const timeout = await new SafetyPolicy(store, { timeoutMs: 30 }).inspect({ tool: tool('echo fixture') });
  assert.equal(timeout.status, 'unavailable'); assert.ok(timeout.reasonCodes.includes('classifier_timeout'));
  config.SECURITY_PROMPT_THRESHOLD = { value: '0.8' };
  assert.ok((await policy.inspect({ tool: tool('echo fixture') })).reasonCodes.includes('invalid_threshold'));
});

test('logits and current flat HF responses are supported while cancellation remains cancellation', async t => {
  const { policy, config, setResponse } = await fixture(t);
  config.SECURITY_PROMPT_THRESHOLD = { value: 0.7 };
  setResponse(() => [{ label: 'LABEL_1', score: 1001 }, { label: 'LABEL_0', score: 1000 }]);
  const result = await policy.inspect({ tool: tool('echo fixture') });
  assert.equal(result.status, 'flagged'); assert.ok(Math.abs(result.confidence - 0.7310585786) < 1e-8);
  const controller = new AbortController();
  setResponse(() => { controller.abort(new DOMException('Fixture cancelled', 'AbortError')); return undefined; });
  await assert.rejects(policy.inspect({ tool: tool('echo fixture'), signal: controller.signal }), error => error.name === 'AbortError');
});
