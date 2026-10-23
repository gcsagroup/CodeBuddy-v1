import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectWorkflows, prepareFallback } from '../comfyui-fallback.mjs';
import { workflowCandidates } from '../comfyui-workflows.mjs';
import { comfyuiTool } from '../comfyui-tool.mjs';
import { comfyuiVideoTool } from '../comfyui-video-tool.mjs';
import { createHarnessDriver } from '../harness/index.mjs';

const id = 'ca1bb25e-b879-4f2c-8ddb-2d0d50cf1b39';
function inventory() {
  const node = (required, output, output_node = false) => ({ input: { required }, output, output_node });
  return {
    CheckpointLoaderSimple: node({ ckpt_name: [['fixture.safetensors']] }, ['MODEL', 'CLIP', 'VAE']),
    CLIPTextEncode: node({ text: ['STRING'], clip: ['CLIP'] }, ['CONDITIONING']),
    EmptyLatentImage: node({ width: ['INT'], height: ['INT'], batch_size: ['INT'] }, ['LATENT']),
    KSampler: node({ sampler_name: [['euler']], scheduler: [['normal']] }, ['LATENT']),
    VAEDecode: node({}, ['IMAGE']), LoadImage: node({ image: [['example.png']] }, ['IMAGE', 'MASK']),
    SaveImage: node({ images: ['IMAGE'], filename_prefix: ['STRING'] }, [], true),
    CreateVideo: node({ images: ['IMAGE'], fps: ['FLOAT'] }, ['VIDEO']),
    SaveVideo: node({ video: ['VIDEO'], format: [['mp4']], codec: [['h264']] }, [], true),
  };
}
function graph() {
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'fixture.safetensors' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: '$prompt', clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    '5': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], seed: 1, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'model-selected-path' } },
  };
}
const input = () => ({ operation: 'generate', prompt: 'A blue cat', fallback_workflow: graph(), request_id: id });
function installedPresets(kind = 'image', mode = 'text_to_image', count = 0) {
  const info = inventory();
  for (const spec of workflowCandidates(kind, mode, count)) for (const node of Object.values(spec.graph)) {
    info[node.class_type] ??= { input: { required: {} }, output: ['ANY', 'ANY', 'ANY'] };
    for (const [key, value] of Object.entries(node.inputs)) {
      const options = info[node.class_type].input.required[key]?.[0];
      if (Array.isArray(options) && !Array.isArray(value) && !options.includes(value)) options.push(value);
    }
  }
  return info;
}

test('only absent dependencies authorize creation; one usable video template is enough to keep reuse', () => {
  const info = installedPresets();
  assert.equal(inspectWorkflows(info, 'image', 'text_to_image', 0).creation_allowed, false);
  assert.throws(() => prepareFallback(input(), 'image', [], id, info), /existing workflow/);
  info.UNETLoader.input.required.unet_name = [[]];
  const inspection = inspectWorkflows(info, 'image', 'text_to_image', 0, ['CheckpointLoaderSimple']);
  assert.equal(inspection.creation_allowed, true);
  assert.ok(inspection.workflows[0].missing.some(item => item.field === 'unet_name'));
  assert.deepEqual(inspection.schemas.CheckpointLoaderSimple, inventory().CheckpointLoaderSimple);
  const videoInfo = installedPresets('video', 'text_to_video');
  const specs = workflowCandidates('video', 'text_to_video', 0);
  const resClass = specs[0].graph[specs[0].resolutionNode].class_type;
  videoInfo[resClass].input.required.megapixels = [[0.6]];
  const video = inspectWorkflows(videoInfo, 'video', 'text_to_video', 0);
  assert.equal(video.workflows.filter(item => item.dependencies_available).length, 1);
  assert.equal(video.creation_allowed, false);
});

test('fallback binds prompt, explicit parameters and real references without modifying its source', () => {
  const args = input();
  args.width = 768; args.seed = 42; args.transparent_background = true;
  args.fallback_workflow['4'].inputs.width = '$width'; args.fallback_workflow['5'].inputs.seed = '$seed';
  const result = prepareFallback(args, 'image', [], id, inventory());
  assert.match(result.graph['2'].inputs.text, /A blue cat.*\nTransparent background/);
  assert.equal(result.graph['4'].inputs.width, 768);
  assert.equal(result.graph['5'].inputs.seed, 42);
  assert.equal(result.graph['7'].inputs.filename_prefix, `CodeBuddy/${id}`);
  assert.equal(args.fallback_workflow['2'].inputs.text, '$prompt');
  assert.equal(result.metadata.source, 'agent-fallback');
  const edit = input();
  edit.fallback_workflow['4'] = { class_type: 'LoadImage', inputs: { image: '$reference:0' } };
  // Link type compatibility is validated by ComfyUI, while the host owns file binding.
  assert.equal(prepareFallback(edit, 'image', ['uploaded.png'], id, inventory()).graph['4'].inputs.image, 'uploaded.png');
  assert.throws(() => prepareFallback(edit, 'image', [], id, inventory()), /uploaded/);
  assert.throws(() => prepareFallback(input(), 'image', ['uploaded.png'], id, inventory()), /every supplied reference/);
});

test('unknown inventories, graphs, models, cycles and ignored user parameters fail before submission', () => {
  for (const info of [{}, { Bad: {} }, null]) assert.throws(() => inspectWorkflows(info, 'image', undefined, 0), /inventory/);
  const cases = [
    [a => { a.fallback_workflow = null; }, /API graph/],
    [a => { a.workflow_id = 'qwen_image'; }, /either/],
    [a => { a.fallback_workflow['1'].inputs.ckpt_name = 'missing.safetensors'; }, /dependencies unavailable/],
    [a => { a.fallback_workflow['2'].inputs.clip = ['missing', 0]; }, /Invalid connection/],
    [a => { a.fallback_workflow['2'].inputs.clip = ['5', 0]; }, /cycle/],
    [a => { a.fallback_workflow['unused'] = structuredClone(a.fallback_workflow['1']); }, /Every fallback node/],
    [a => { a.width = 512; }, /must be bound/],
    [a => { a.fallback_workflow['4'].inputs.width = '$width'; }, /Supply width/],
    [a => { a.fallback_workflow['2'].inputs.text = 'Ignored user prompt'; }, /\$prompt/],
    [a => { a.fallback_workflow['1'].class_type = 'UninstalledNode'; }, /Unknown or invalid/],
  ];
  for (const [mutate, pattern] of cases) { const args = input(); mutate(args); assert.throws(() => prepareFallback(args, 'image', [], id, inventory()), pattern); }
});

test('video fallback submits installed nodes and preserves server validation errors without retrying', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codebuddy-fallback-video-'));
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('codebuddy-fallback-video-'));
    await rm(root, { recursive: true, force: true });
  });
  const args = { ...input(), mode: 'text_to_video' };
  args.fallback_workflow['7'] = { class_type: 'SaveVideo', inputs: { video: ['8', 0], format: 'mp4', codec: 'h264' } };
  args.fallback_workflow['8'] = { class_type: 'CreateVideo', inputs: { images: ['6', 0], fps: 24 } };
  let calls = 0, rejected = false;
  const tool = comfyuiVideoTool({ cwd: root, dataDir: root, sessionId: 'video', baseUrl: 'http://fixture.test', fetchImpl: async (url, options) => {
    if (url.endsWith('/object_info')) return Response.json(inventory());
    assert.ok(url.endsWith('/prompt'));
    calls++;
    const graph = JSON.parse(options.body).prompt;
    assert.equal(graph['7'].class_type, 'SaveVideo');
    assert.equal(graph['7'].inputs.filename_prefix, `CodeBuddy/${JSON.parse(options.body).prompt_id}`);
    assert.equal(graph['2'].inputs.text, args.prompt);
    return rejected ? Response.json({ error: 'prompt_outputs_failed_validation', node_errors: { '8': { errors: ['invalid video input'] } } }, { status: 400 }) : Response.json({ prompt_id: id });
  } });
  assert.equal((await tool.execute(args)).status, 'queued');
  rejected = true;
  const invalid = { ...args, request_id: 'ca1bb25e-b879-4f2c-8ddb-2d0d50cf1b40' };
  const result = await tool.execute(invalid);
  assert.equal(result.status, 'failed'); assert.match(result.error, /invalid video input/);
  assert.equal((await tool.execute(invalid)).status, 'failed'); assert.equal(calls, 2);
});

test('HTTP service and Harness preserve the fallback graph, receipt, completion and idempotency', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codebuddy-fallback-'));
  const png = await readFile(new URL('../../ui/desktop/src/pets/assets/red-panda/sprites.png', import.meta.url));
  let info = inventory(), submitted = [], completed = false, failInventory = false;
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/object_info') {
      if (failInventory) { res.writeHead(503); res.end('{"error":"offline"}'); }
      else res.end(JSON.stringify(info));
    } else if (req.url === '/prompt') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      submitted.push(JSON.parse(Buffer.concat(chunks))); res.end(JSON.stringify({ prompt_id: id }));
    } else if (req.url.startsWith('/history/')) res.end(JSON.stringify(completed ? { [id]: { status: { completed: true }, outputs: { '7': { images: [{ filename: 'result.png', type: 'output' }] } } } } : {}));
    else if (req.url.startsWith('/view?')) { res.setHeader('Content-Type', 'image/png'); res.end(png); }
    else if (req.url === '/queue') res.end(JSON.stringify({ queue_running: [], queue_pending: [[0, id]] }));
    else { res.writeHead(404); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let driver;
  t.after(async () => {
    await driver?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('codebuddy-fallback-'));
    await rm(root, { recursive: true, force: true });
  });
  const options = { cwd: root, dataDir: root, sessionId: 'fallback', baseUrl: `http://127.0.0.1:${server.address().port}`, fetchImpl: (...args) => fetch(...args) };
  const tool = comfyuiTool(options);
  assert.equal((await tool.execute({ operation: 'inspect', mode: 'text_to_image' })).creation_allowed, true);
  info = installedPresets();
  await assert.rejects(tool.execute(input()), /existing workflow/);
  assert.equal(submitted.length, 0);
  failInventory = true;
  await assert.rejects(tool.execute(input()), /HTTP 503/);
  assert.equal(submitted.length, 0);
  failInventory = false; info = inventory();
  driver = await createHarnessDriver({ dataDir: path.join(root, 'harness'), cwd: root });
  const { sessionId } = await driver.createSession({ cwd: root, provider: { id: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture' }, model: 'fixture', options: { tools: [tool], toolFilter: { allow: [] } } });
  await driver.callTool(sessionId, 'search_mcp_tools', { names: [tool.name] }, { onPermission: () => true });
  const reply = await driver.callTool(sessionId, tool.name, input(), { onPermission: () => true });
  assert.equal(reply.isError, false, JSON.stringify(reply)); assert.match(JSON.stringify(reply), /queued/);
  assert.equal(submitted[0].prompt['2'].inputs.text, 'A blue cat');
  assert.equal(submitted[0].prompt['1'].class_type, 'CheckpointLoaderSimple');
  failInventory = true;
  assert.equal((await comfyuiTool(options).execute(input())).status, 'queued');
  assert.equal(submitted.length, 1);
  completed = true;
  const result = await tool.execute({ operation: 'status', job_id: id });
  assert.equal(result.status, 'completed'); assert.equal(result.workflow.source, 'agent-fallback');
  assert.deepEqual(await readFile(result.images[0].path), png);
  // Video exposes the same dependency gate, with video-specific modes/output contracts.
  failInventory = false;
  assert.equal((await comfyuiVideoTool(options).execute({ operation: 'inspect', mode: 'text_to_video' })).creation_allowed, true);
});
