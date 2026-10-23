import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { comfyuiVideoTool, comfyVideoWorkflow, inspectMp4 } from '../comfyui-video-tool.mjs';
import { createHarnessDriver } from '../harness/index.mjs';

const id = '6f2c1cde-4707-4b12-87cd-a8b116b386ab';
const input = { operation: 'generate', mode: 'text_to_video', prompt: 'A small rabbit waves beside a stream', duration_seconds: 5, request_id: id };
function metadataFixture() {
  const box = (type, data) => { const b = Buffer.alloc(8); b.writeUInt32BE(data.length + 8); b.write(type, 4); return Buffer.concat([b, data]); };
  const tkhd = Buffer.alloc(84); tkhd.writeUInt32BE(640 * 65536, 76); tkhd.writeUInt32BE(640 * 65536, 80);
  const mdhd = Buffer.alloc(24); mdhd.writeUInt32BE(24, 12); mdhd.writeUInt32BE(124, 16);
  const hdlr = Buffer.alloc(24); hdlr.write('vide', 8);
  return Buffer.concat([box('ftyp', Buffer.from('isom0000')), box('moov', box('trak', Buffer.concat([box('tkhd', tkhd), box('mdia', Buffer.concat([box('mdhd', mdhd), box('hdlr', hdlr)]))]))), box('mdat', Buffer.from('fixture'))]);
}
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codebuddy-video-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace'); await mkdir(cwd);
  const calls = []; let state = 'queued';
  const bytes = metadataFixture();
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options });
    if (url.endsWith('/prompt')) return Response.json({ prompt_id: id });
    if (url.endsWith('/upload/image')) return Response.json({ name: 'reference.png' });
    if (url.includes('/cancel')) { state = 'cancelled'; return Response.json({ cancelled: true }); }
    if (url.includes('/history/')) return Response.json(state === 'completed' ? { [id]: { status: { completed: true }, outputs: { save: { images: [{ filename: 'clip.mp4', type: 'output' }] } } } }
      : state === 'failed' ? { [id]: { status: { status_str: 'error', messages: [['execution_error', { exception_message: 'out of memory' }]] } } } : {});
    if (url.endsWith('/queue')) return Response.json({ queue_running: state === 'running' ? [[0, id]] : [], queue_pending: state === 'queued' ? [[0, id]] : [] });
    if (url.includes('/view?')) return new Response(bytes);
    throw new Error(url);
  };
  const options = { cwd, dataDir: root, sessionId: 'video-test', baseUrl: 'http://comfy.test', fetchImpl };
  return { root, cwd, options, calls, bytes, state: s => { state = s; }, tool: comfyuiVideoTool(options) };
}

test('T2V and I2V connect actual conditioning to the sampler, use installed native nodes and valid frame grid', () => {
  const text = comfyVideoWorkflow(input, [], id);
  assert.equal(text.encode.inputs.length, 124);
  assert.equal(text.encode.inputs.first_frame, undefined);
  const image = comfyVideoWorkflow({ ...input, mode: 'image_to_video', image_path: 'rabbit.png' }, ['uploaded.png'], id);
  assert.deepEqual(image.encode.inputs.first_frame, ['reference', 0]);
  assert.equal(image.reference.inputs.image, 'uploaded.png');
  assert.deepEqual(image.guider.inputs.conditioning, ['encode', 0]);
  assert.deepEqual(image.sample.inputs.latent_image, ['encode', 1]);
  assert.deepEqual(image.video.inputs.audio, ['audio', 0]);
  assert.throws(() => comfyVideoWorkflow({ ...input, mode: 'image_to_video' }, [], id), /image_path/);
  assert.throws(() => comfyVideoWorkflow({ ...input, duration_seconds: 100 }, [], id), /integer/);
  assert.throws(() => comfyVideoWorkflow({ ...input, width: 1344, height: 1344 }, [], id), /resolution/);
});
test('receipt survives recreation, downloads MP4 only on completion, and cannot be queried by another session', async t => {
  const f = await fixture(t);
  assert.equal((await f.tool.execute(input)).status, 'queued');
  await f.tool.execute(input);
  assert.equal(f.calls.filter(c => c.url.endsWith('/prompt')).length, 1);
  f.state('running'); assert.equal((await f.tool.execute({ operation: 'status', job_id: id })).status, 'running');
  f.state('completed');
  const result = await comfyuiVideoTool({ ...f.options, baseUrl: 'http://changed.test' }).execute({ operation: 'status', job_id: id });
  assert.equal(result.status, 'completed'); assert.equal(result.videos[0].duration_seconds, 124 / 24);
  assert.deepEqual(await readFile(result.videos[0].path), f.bytes);
  assert.equal(result.videos[0].preview_url, 'http://comfy.test/view?filename=clip.mp4&subfolder=&type=output');
  assert.equal(result.videos[0].markdown, `[Play generated video](${result.videos[0].preview_url})`);
  assert.equal(path.dirname(result.videos[0].path), path.join(f.cwd, 'generated-videos', id));
  assert.ok(f.calls.every(c => c.url.startsWith('http://comfy.test/')));
  const receiptPath = path.join(f.root, 'video-jobs', Buffer.from('video-test').toString('hex'), `${id}.json`);
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  delete receipt.videos[0].preview_url;
  receipt.videos[0].markdown = '![Generated video](old.mp4)';
  await writeFile(receiptPath, JSON.stringify(receipt));
  const offline = await comfyuiVideoTool({ ...f.options, fetchImpl: async () => { throw new Error('offline'); } }).execute({ operation: 'status', job_id: id });
  assert.equal(offline.status, 'completed');
  f.state('unavailable');
  assert.equal((await f.tool.execute({ operation: 'status', job_id: id })).status, 'completed');
  f.state('completed');
  const repaired = await f.tool.execute({ operation: 'status', job_id: id });
  assert.equal(repaired.videos[0].markdown, result.videos[0].markdown);
  assert.equal(f.calls.filter(c => c.url.endsWith('/prompt')).length, 1);
  await assert.rejects(comfyuiVideoTool({ ...f.options, sessionId: 'other' }).execute({ operation: 'status', job_id: id }), /ENOENT/);
});
test('I2V uploads real image bytes; invalid output and paths are never reported as completed', async t => {
  const f = await fixture(t);
  const png = await readFile(new URL('../../ui/desktop/src/pets/assets/red-panda/sprites.png', import.meta.url));
  await writeFile(path.join(f.cwd, 'reference.png'), png);
  await f.tool.execute({ ...input, mode: 'image_to_video', image_path: 'reference.png' });
  assert.deepEqual(Buffer.from(await f.calls.find(c => c.url.endsWith('/upload/image')).body.get('image').arrayBuffer()), png);
  f.state('completed');
  await assert.rejects(comfyuiVideoTool({ ...f.options, fetchImpl: (url, options) => url.includes('/view?') ? new Response('not a video') : f.options.fetchImpl(url, options) }).execute({ operation: 'status', job_id: id }), /MP4/);
  assert.throws(() => inspectMp4(f.bytes.subarray(0, -2)), /MP4/);
  const outside = await f.tool.execute({ ...input, request_id: '6f2c1cde-4707-4b12-87cd-a8b116b386ac', mode: 'image_to_video', image_path: '../missing.png' });
  assert.equal(outside.status, 'failed');
});
test('video failures and cancellation remain scoped to one job', async t => {
  const f = await fixture(t); await f.tool.execute(input); f.state('running');
  assert.equal((await f.tool.execute({ operation: 'cancel', job_id: id })).status, 'cancelled');
  assert.ok(!f.calls.some(c => c.url.endsWith('/interrupt')));
  const g = await fixture(t); await g.tool.execute(input); g.state('failed');
  const failure = await g.tool.execute({ operation: 'status', job_id: id });
  assert.equal(failure.status, 'failed'); assert.match(failure.error, /out of memory/);
});
test('official Harness discovers and executes the video tool with the existing permission boundary', async t => {
  const f = await fixture(t);
  const driver = await createHarnessDriver({ dataDir: path.join(f.root, 'harness'), cwd: f.cwd });
  try {
    const { sessionId } = await driver.createSession({ cwd: f.cwd, provider: { id: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture' }, model: 'fixture', options: { tools: [f.tool], toolFilter: { allow: [] } } });
    assert.equal((await driver.callTool(sessionId, 'search_mcp_tools', { names: ['generate_video'] }, { onPermission: () => true })).isError, false);
    const result = await driver.callTool(sessionId, 'generate_video', input, { onPermission: () => true });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.match(JSON.stringify(result), /queued/);
  } finally { await driver.close(); }
});


test('live catalog is session-scoped and publishes completion once without resubmission', async t => {
  const f = await fixture(t);
  await f.tool.execute(input);
  assert.equal(JSON.parse(f.calls.find(call => call.url.endsWith('/prompt')).body).extra_data.preview_method, 'auto');
  assert.deepEqual(await comfyuiVideoTool({ ...f.options, sessionId: 'other' }).jobs(), []);
  f.state('running');
  const active = await f.tool.jobs();
  assert.equal(active[0].status, 'running');
  assert.equal(active[0].videos.length, 0);
  f.state('completed');
  const [catalog, receipt] = await Promise.all([f.tool.jobs(), f.tool.execute({ operation: 'status', job_id: id })]);
  assert.equal(catalog[0].status, 'completed');
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.live, undefined); // Preview bytes never enter the model transcript.
  assert.ok((await readFile(catalog[0].videos[0].path)).equals(f.bytes));
  assert.equal(f.calls.filter(call => call.url.endsWith('/prompt')).length, 1);
  assert.equal(f.calls.filter(call => call.url.includes('/view?')).length, 1);
});
