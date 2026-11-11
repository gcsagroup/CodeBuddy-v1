import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { createHarnessDriver } from '../harness/index.mjs';
import { comfyuiVideoTool } from '../comfyui-video-tool.mjs';
import { comfyuiTool } from '../comfyui-tool.mjs';
import { savedFixtureResponse } from './comfyui-catalog-fixture.mjs';
import { replyToNoActionReview } from '../harness/test/review-fixture.mjs';
const { installToolDiscovery } = await import('../harness/tool-discovery.mjs');

test('Harness accepts scalar workflow controls and rejects composite values before dispatch', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codebuddy-comfy-controls-'));
  const driver = await createHarnessDriver({ dataDir: path.join(root, 'state'), cwd: root });
  t.after(async () => { await driver.close(); await rm(root, { recursive: true, force: true }); });
  const calls = [];
  const tool = comfyuiVideoTool({ cwd: root, dataDir: root, sessionId: 'fixture', baseUrl: 'http://fixture' });
  const { sessionId } = await driver.createSession({ cwd: root, provider: { id: 'fixture', baseUrl: 'http://127.0.0.1:1', contextWindow: 65536 }, model: 'fixture', options: {
    tools: [{ ...tool, execute: async args => { calls.push(args); return { status: 'queued', job_id: 'fixture' }; } }],
  } });
  const input = { operation: 'generate', mode: 'text_to_video', prompt: 'Teapot steam', duration_seconds: 20, width: 512, height: 288,
    workflow_parameters: [{ parameter: '140:139/value', value: true }, { parameter: '140:138/value', value: 8 }, { parameter: 'sampler', value: 'euler' }] };
  const result = await driver.callTool(sessionId, 'generate_video', input, { onPermission: () => true });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.deepEqual(calls, [input], 'boolean, numeric and string controls must reach the tool without coercion');
  for (const value of [null, [], {}, { value: 8 }]) {
    const invalid = await driver.callTool(sessionId, 'generate_video', { ...input, workflow_parameters: [{ parameter: '140:138/value', value }] }, { onPermission: () => true });
    assert.equal(invalid.isError, true);
  }
  assert.equal(calls.length, 1, 'invalid composite controls must never reach submission');
});

test('media skill revelation respects masked tools, provider identity and agent scope', async () => {
  const hooks = new Map(), catalog = [{ name: 'generate_image', parameters: { type: 'object' } }];
  const agent = { id: 'observer', session: { requestHeader: () => undefined } };
  const ctx = { tools: { schemas: () => catalog, register() {}, get() {} }, systemPrompt: { section() {} }, on: (event, hook) => hooks.set(event, hook) };
  installToolDiscovery(ctx, agent);
  const assemble = () => hooks.get('system-prompt/assemble')({}, {}, async () => ({ tools: catalog }));
  const loaded = { value: { name: 'comfyui', provider: 'codebuddy-comfyui-skill' } };
  for (const [exec, result] of [
    [{ agent: { id: 'other' }, name: 'skill' }, loaded],
    [{ agent, name: 'skill' }, { ...loaded, isError: true }],
    [{ agent, name: 'skill' }, { value: { name: 'comfyui', provider: 'project' } }],
  ]) { hooks.get('tools/result')(exec, result); assert.equal((await assemble()).tools.length, 0); }
  hooks.get('tools/result')({ agent, name: 'skill' }, loaded);
  assert.deepEqual((await assemble()).tools.map(t => t.name), ['generate_image']);
});

test('official Harness lists and model-loads the bundled ComfyUI skill, reveals only registered media tools and preserves permissions', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codebuddy-comfy-skill-'));
  const requests = []; let serviceCalls = 0;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const request = JSON.parse(body);
    if (replyToNoActionReview(request, res)) return;
    requests.push(request);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (requests.length === 1) {
      send({ tool_calls: [{ index: 0, id: 'skill', type: 'function', function: { name: 'skill', arguments: JSON.stringify({ name: 'comfyui' }) } }] }); send({}, 'tool_calls');
    } else { send({ content: 'Fixture response' }); send({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const driver = await createHarnessDriver({ dataDir: path.join(root, 'state'), cwd: root });
  t.after(async () => { await driver.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const tool = comfyuiVideoTool({ cwd: root, dataDir: root, sessionId: 'fixture', baseUrl: 'http://fixture', fetchImpl: async url => {
    serviceCalls++; return savedFixtureResponse(url) ?? Response.json({});
  } });
  const { sessionId } = await driver.createSession({ cwd: root, provider: { id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}`, contextWindow: 65536 }, model: 'fixture', options: { tools: [tool] } });
  const builtin = (await driver.listBuiltinSkills(root)).find(s => s.name === 'comfyui');
  assert.equal(builtin?.source, 'bundled');
  await driver.prompt(sessionId, '请加载 ComfyUI 技能说明，暂不生成视频；读完说明即可回复。', { onPermission: () => true });
  assert.equal(requests.length, 2);
  assert.ok(requests[0].tools.some(t => t.function.name === 'skill'));
  assert.ok(!requests[0].tools.some(t => t.function.name === 'generate_video'));
  assert.ok(requests[1].tools.some(t => t.function.name === 'generate_video'));
  assert.ok(!requests[1].tools.some(t => t.function.name === 'generate_image'));
  assert.equal(serviceCalls, 0, 'loading guidance must not submit generation or contact ComfyUI');
  const referencePath = fileURLToPath(new URL('../harness/skills/comfyui/references/requests.json', import.meta.url));
  const reference = await driver.callTool(sessionId, 'read', { file_path: referencePath }, { onPermission: () => true });
  assert.equal(reference.isError, false, 'the native read tool must reach bundled skill references');
  assert.equal(serviceCalls, 0, 'reading a reference must not contact ComfyUI');
  const denied = await driver.callTool(sessionId, 'generate_video', { operation: 'generate', mode: 'text_to_video', prompt: 'test' }, { onPermission: () => false });
  assert.equal(denied.isError, true); assert.equal(serviceCalls, 0);
  const inspected = await driver.callTool(sessionId, 'generate_video', { operation: 'inspect', mode: 'text_to_video' }, { onPermission: () => true });
  assert.equal(inspected.isError, false); assert.ok(serviceCalls > 0);
});

test('published skill request examples pass real tool binding, upload and single-submission paths for all five modes', async t => {
  const examples = JSON.parse(await readFile(new URL('../harness/skills/comfyui/references/requests.json', import.meta.url), 'utf8'));
  assert.deepEqual(examples.map(example => example.inspect.mode).sort(), ['image_to_image', 'image_to_video', 'reference_to_video', 'text_to_image', 'text_to_video']);
  const root = await mkdtemp(path.join(os.tmpdir(), 'codebuddy-comfy-examples-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const png = await readFile(new URL('../../ui/desktop/src/pets/assets/red-panda/sprites.png', import.meta.url));
  for (const filename of ['reference-1.png', 'reference-2.png']) await writeFile(path.join(root, filename), png);
  for (const example of examples) {
    await t.test(example.inspect.mode, async () => {
      const calls = []; let promptId;
      const fetchImpl = async (url, options) => {
        const catalog = savedFixtureResponse(url); if (catalog) return catalog;
        calls.push({ url, ...options });
        if (url.endsWith('/upload/image')) return Response.json({ name: `reference-${calls.length}.png` });
        if (url.endsWith('/prompt')) { promptId = JSON.parse(options.body).prompt_id; return Response.json({ prompt_id: promptId }); }
        if (url.includes('/history/')) return Response.json({});
        if (url.endsWith('/queue')) return Response.json({ queue_pending: [[0, promptId]], queue_running: [] });
        throw new Error(`Unexpected fixture request: ${url}`);
      };
      const options = { cwd: root, dataDir: root, sessionId: example.inspect.mode, baseUrl: 'http://fixture', fetchImpl };
      const tool = example.tool === 'generate_video' ? comfyuiVideoTool(options) : comfyuiTool(options);
      const replace = (value, workflow) => JSON.parse(JSON.stringify(value)
        .replaceAll('$workflow_name', workflow ?? '')
        .replaceAll('$image_1', 'reference-1.png').replaceAll('$image_2', 'reference-2.png'));
      const inventory = await tool.execute(replace(example.inspect));
      assert.equal(calls.length, 0, 'inspection must not upload or submit');
      const selected = inventory.workflows.find(entry => entry.compatible && entry.dependencies_available);
      assert.ok(selected, 'the scenario must select a live-compatible saved workflow');
      const input = replace(example.generate, selected.label);
      const receipt = await tool.execute(input);
      assert.equal(receipt.status, 'queued', receipt.error ?? undefined);
      assert.equal(receipt.workflow.id, selected.id);
      const submissions = calls.filter(call => call.url.endsWith('/prompt'));
      assert.equal(submissions.length, 1);
      const graph = JSON.parse(submissions[0].body).prompt;
      assert.ok(Object.values(graph).some(node => Object.values(node.inputs).includes(input.prompt)), 'the actual prompt must reach the graph');
      assert.equal(calls.filter(call => call.url.endsWith('/upload/image')).length, input.reference_images?.length ?? (input.image_path ? 1 : 0));
      if (input.duration_seconds !== undefined) assert.ok(Object.values(graph).some(node => node.class_type === 'PrimitiveFloat' && node.inputs.value === input.duration_seconds));
      const status = await tool.execute({ operation: 'status', job_id: receipt.job_id, wait_seconds: 0 });
      assert.equal(status.status, 'queued');
      assert.equal(calls.filter(call => call.url.endsWith('/prompt')).length, 1, 'following a job must not submit again');
    });
  }
});
