import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { comfyuiTool, comfyWorkflow, comfyuiUrl } from '../comfyui-tool.mjs';
import { validatePreference } from '../settings.mjs';
import { createHarnessDriver } from '../harness/index.mjs';

const id = 'bafe8f1d-310a-4e29-92e7-73e7ba920ade';
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codebuddy-comfy-')));
  const cwd = path.join(root, 'workspace'); await mkdir(cwd);
  t.after(async () => {
    assert.equal(path.dirname(root), await realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('codebuddy-comfy-'));
    await rm(root, { recursive: true, force: true });
  });
  const png = await readFile(new URL('../../ui/desktop/src/pets/assets/red-panda/sprites.png', import.meta.url));
  const calls = []; let state = 'queued';
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options });
    if (url.endsWith('/prompt')) return Response.json({ prompt_id: id });
    if (url.includes('/upload/image')) return Response.json({ name: 'reference.png', subfolder: 'input', type: 'input' });
    if (url.includes('/cancel')) { state = 'cancelled'; return Response.json({ cancelled: true }); }
    if (url.includes('/history/')) return Response.json(state === 'completed' ? { [id]: { status: { completed: true, status_str: 'success' }, outputs: { save: { images: [{ filename: '../../remote.png', subfolder: 'CodeBuddy', type: 'output' }] } } } }
      : state === 'failed' ? { [id]: { status: { status_str: 'error', messages: [['execution_error', { exception_message: 'GPU OOM' }]] } } } : {});
    if (url.endsWith('/queue')) return Response.json({ queue_running: state === 'running' ? [[1, id]] : [], queue_pending: state === 'queued' ? [[1, id]] : [] });
    if (url.includes('/view?')) return new Response(png);
    throw new Error(`Unexpected request ${url}`);
  };
  const options = { cwd, dataDir: root, sessionId: 'test-session', baseUrl: 'http://comfy.test', fetchImpl };
  return { root, cwd, png, calls, options, tool: comfyuiTool(options), state: value => { state = value; } };
}
const generate = { operation: 'generate', prompt: 'A watercolor mountain', request_id: id };

test('low disk space prevents submission; completed remote output can be downloaded after space is freed without resubmission', async t => {
  const f = await fixture(t);
  let free = 100 * 1024 * 1024;
  const tool = comfyuiTool({ ...f.options, statfsImpl: async () => ({ bavail: free, bsize: 1 }) });
  await assert.rejects(tool.execute(generate), /Low disk space/);
  assert.equal(f.calls.length, 0);
  free = 2 * 1024 ** 3;
  assert.equal((await tool.execute(generate)).status, 'queued');
  f.state('completed');
  free = 100 * 1024 * 1024;
  await assert.rejects(tool.execute({ operation: 'status', job_id: id }), /Low disk space/);
  assert.equal((await tool.execute(generate)).status, 'queued');
  free = 2 * 1024 ** 3;
  const result = await tool.execute({ operation: 'status', job_id: id });
  assert.equal(result.status, 'completed');
  assert.deepEqual(await readFile(result.images[0].path), f.png);
  assert.equal(f.calls.filter(x => x.url.endsWith('/prompt')).length, 1);
});

test('real PNG result survives tool recreation, routes by prompt ID, and repeated submit does not enqueue twice', async t => {
  const f = await fixture(t);
  assert.equal((await f.tool.execute(generate)).status, 'queued');
  await f.tool.execute(generate);
  assert.equal(f.calls.filter(x => x.url.endsWith('/prompt')).length, 1);
  const tool = comfyuiTool({ ...f.options, baseUrl: 'http://new-setting.test' });
  f.state('running'); assert.equal((await tool.execute({ operation: 'status', job_id: id })).status, 'running');
  f.state('completed');
  const result = await tool.execute({ operation: 'status', job_id: id });
  assert.equal(result.status, 'completed');
  assert.deepEqual(await readFile(result.images[0].path), f.png);
  assert.equal(path.dirname(result.images[0].path), path.join(f.cwd, 'generated-images', id));
  assert.equal(result.images[0].width, 1152);
  assert.ok(f.calls.every(x => x.url.startsWith('http://comfy.test/')));
  await assert.rejects(tool.execute({ ...generate, prompt: 'Different request' }), /different image request/);
  await assert.rejects(comfyuiTool({ ...f.options, sessionId: 'another' }).execute({ operation: 'status', job_id: id }), /ENOENT/);
});
test('reference editing uploads actual workspace bytes and builds transparent pose request without pet-only constraints', async t => {
  const f = await fixture(t); await writeFile(path.join(f.cwd, 'reference.png'), f.png);
  await f.tool.execute({ ...generate, reference_images: ['reference.png'], transparent_background: true, width: 1536 });
  const upload = f.calls.find(x => x.url.endsWith('/upload/image')).body;
  assert.deepEqual(Buffer.from(await upload.get('image').arrayBuffer()), f.png);
  const graph = JSON.parse(f.calls.find(x => x.url.endsWith('/prompt')).body).prompt;
  assert.deepEqual(graph.encode.inputs['images.image_1'], ['reference0', 0]);
  assert.match(graph.encode.inputs.prompt, /watercolor mountain/);
  assert.match(graph.encode.inputs.prompt, /alpha channel/);
  assert.equal(graph.latent.inputs.width, 1536);
});
test('invalid inputs, outside reference and bad server image never publish an image', async t => {
  const f = await fixture(t);
  assert.throws(() => comfyuiUrl('file:///tmp'), /HTTP/);
  assert.throws(() => validatePreference('comfyuiBaseUrl', 'https://user:secret@host'), /credentials/);
  assert.throws(() => comfyWorkflow({ prompt: 'x', width: 999 }, [], id), /multiple/);
  await writeFile(path.join(f.root, 'outside.png'), f.png);
  assert.equal((await f.tool.execute({ ...generate, reference_images: ['../outside.png'] })).status, 'failed');
  assert.equal(f.calls.length, 0);
  const second = 'bafe8f1d-310a-4e29-92e7-73e7ba920adf';
  await f.tool.execute({ ...generate, request_id: second }); f.state('completed');
  const bad = comfyuiTool({ ...f.options, fetchImpl: (url, opts) => url.includes('/view?') ? Promise.resolve(new Response('not png')) : f.options.fetchImpl(url, opts) });
  await assert.rejects(bad.execute({ operation: 'status', job_id: second }), /PNG/);
  assert.deepEqual(await readdir(path.join(f.cwd, 'generated-images', second)), []);
});
test('server failures and ambiguous submission stay truthful; cancellation targets only this prompt', async t => {
  const f = await fixture(t);
  const uncertain = comfyuiTool({ ...f.options, fetchImpl: async () => { throw new Error('Connection lost'); } });
  assert.equal((await uncertain.execute(generate)).status, 'submission_unknown');
  assert.equal((await uncertain.execute(generate)).status, 'submission_unknown');
  f.state('running');
  const cancelled = await f.tool.execute({ operation: 'cancel', job_id: id });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancellation_confirmed, true);
  assert.ok(f.calls.some(x => x.url.endsWith(`/api/jobs/${id}/cancel`)));
  assert.ok(f.calls.every(x => !x.url.endsWith('/interrupt')));
});
test('unsupported targeted cancellation never calls a global interrupt', async t => {
  const f = await fixture(t); await f.tool.execute(generate); f.state('running');
  const old = comfyuiTool({ ...f.options, fetchImpl: (url, opts) => url.includes('/cancel') ? Promise.resolve(new Response('', { status: 404 })) : f.options.fetchImpl(url, opts) });
  const result = await old.execute({ operation: 'cancel', job_id: id });
  assert.equal(result.status, 'running'); assert.equal(result.cancellation_confirmed, false);
  assert.ok(f.calls.every(x => !x.url.endsWith('/interrupt')));
  f.state('failed');
  const failure = await old.execute({ operation: 'status', job_id: id });
  assert.equal(failure.status, 'failed'); assert.match(failure.error, /GPU OOM/);
});
test('visual inspection refuses an output moved outside the workspace without invalidating the completed job', async t => {
  const f = await fixture(t);
  await f.tool.execute(generate); f.state('completed');
  const completed = await f.tool.execute({ operation: 'status', job_id: id });
  const receiptPath = path.join(f.root, 'image-jobs', Buffer.from('test-session').toString('hex'), `${id}.json`);
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  receipt.images[0].path = path.join(f.root, 'outside.png');
  await writeFile(receipt.images[0].path, f.png);
  await writeFile(receiptPath, JSON.stringify(receipt));
  const result = await f.tool.execute({ operation: 'status', job_id: id });
  assert.equal(result.status, 'completed');
  assert.ok(result.content.every(block => block.type === 'text'));
  assert.match(JSON.stringify(result.content), /inspection is unavailable/);
  assert.deepEqual(await readFile(completed.images[0].path), f.png);
  assert.equal(f.calls.filter(call => call.url.endsWith('/prompt')).length, 1);
});

test('official Harness discovers and calls the image tool without adding it to the global native filter', async t => {
  const f = await fixture(t);
  const driver = await createHarnessDriver({ dataDir: path.join(f.root, 'harness'), cwd: f.cwd });
  try {
    const { sessionId } = await driver.createSession({ cwd: f.cwd, provider: { id: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture' }, model: 'fixture', options: { tools: [f.tool], toolFilter: { allow: [] } } });
    const found = await driver.callTool(sessionId, 'search_mcp_tools', { names: [f.tool.name] }, { onPermission: () => true });
    assert.equal(found.isError, false);
    const result = await driver.callTool(sessionId, f.tool.name, generate, { onPermission: () => true });
    assert.equal(result.isError, false, JSON.stringify(result)); assert.match(JSON.stringify(result), /queued/);
  } finally { await driver.close(); }
});
