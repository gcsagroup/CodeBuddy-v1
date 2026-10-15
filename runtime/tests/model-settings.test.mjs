import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyModelThinking, THINKING_EFFORTS } from '../model-settings.mjs';
import { createHarnessDriver } from '../harness/index.mjs';

test('unknown model defaults do not invent reasoning support or infer it from history retention', () => {
  const provider = { id: 'fixture', preservesThinking: true, compat: { supportsDeveloperRole: false } };
  const result = applyModelThinking(provider);
  assert.equal(result.source, 'provider_default');
  assert.equal(Object.hasOwn(result.provider, 'reasoningEfforts'), false);
  assert.equal(Object.hasOwn(result, 'thinkingEffort'), false);
  assert.notEqual(result.provider, provider);
  assert.deepEqual(provider, { id: 'fixture', preservesThinking: true, compat: { supportsDeveloperRole: false } });
});

test('explicit effort profiles declare only the requested transport control and preserve route isolation', () => {
  const provider = { id: 'fixture', compat: { supportsDeveloperRole: false } };
  for (const requested of THINKING_EFFORTS) {
    const configured = applyModelThinking(provider, requested);
    assert.deepEqual(Object.values(configured.provider.reasoningEfforts), [requested]);
    assert.equal(configured.provider.reasoningEfforts[configured.thinkingEffort], requested);
    assert.equal(configured.verified, false);
    assert.equal(configured.source, 'user_preference');
    assert.equal(configured.provider.compat.supportsDeveloperRole, false);
  }
  assert.equal(provider.reasoningEfforts, undefined);
  assert.throws(() => applyModelThinking(provider, 'max'), /Unknown/);
  assert.throws(() => applyModelThinking({ ...provider, reasoningEfforts: false }, 'high'), /explicitly disables/);
  assert.throws(() => applyModelThinking({ ...provider, reasoningEfforts: { low: 'low' } }, 'high'), /absent/);
  assert.throws(() => applyModelThinking({ ...provider, compat: { supportsReasoningEffort: false } }, 'high'), /different thinking/);
  const declared = applyModelThinking({ ...provider, reasoningEfforts: { off: 'none', high: 'high' } }, 'none');
  assert.equal(declared.thinkingEffort, 'off');
  assert.equal(applyModelThinking({ ...provider, compat: { supportsDeveloperRole: true } }, 'high').provider.compat.supportsDeveloperRole, true, 'An explicit developer-role capability must be preserved');
});

test('all six original UI efforts reach the actual official Harness HTTP completion request', { timeout: 30_000 }, async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw); requests.push(request);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: 'assistant', content: 'ACTUAL_THINKING_REQUEST' }); chunk({}, 'stop'); res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-thinking-'));
  const driver = await createHarnessDriver({ dataDir: path.join(root, 'state'), cwd: root });
  t.after(async () => { await driver.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const provider = { id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'isolated-fixture' };
  for (const effort of [...THINKING_EFFORTS, undefined]) {
    const configured = applyModelThinking(provider, effort);
    const sessionId = randomUUID();
    await driver.createSession({ sessionId, cwd: root, provider: configured.provider, model: 'unknown-thinking-model', options: { systemPrompt: 'RECIPE_ROLE_REGRESSION_742', ...(configured.thinkingEffort === undefined ? {} : { thinkingEffort: configured.thinkingEffort }) } });
    const result = await driver.prompt(sessionId, `thinking_fixture_${effort ?? 'default'}`);
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(requests.at(-1).reasoning_effort, effort, `selected ${effort ?? 'default'} should preserve the intended wire value`);
    const policy = requests.at(-1).messages.find(message => JSON.stringify(message.content).includes('RECIPE_ROLE_REGRESSION_742'));
    assert.equal(policy?.role, 'system', 'Choosing an effort must not silently promote unknown endpoints to developer-role support');
  }
  assert.equal(requests.length, 7);
});
