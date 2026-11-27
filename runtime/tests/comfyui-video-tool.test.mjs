import { savedFixtureResponse } from './comfyui-catalog-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { watchMedia, mediaStreamKey, mediaObservation, stopMedia } from '../comfyui-live.mjs';
import { comfyuiVideoTool, comfyVideoWorkflow, inspectMp4 } from '../comfyui-video-tool.mjs';
import { createHarnessDriver } from '../harness/index.mjs';
import { readMediaLibrary } from '../media-library.mjs';

const id = '6f2c1cde-4707-4b12-87cd-a8b116b386ab';
const input = { operation: 'generate', mode: 'text_to_video', prompt: 'A small rabbit waves beside a stream', duration_seconds: 5, request_id: id };
function metadataFixture(frames = 124, fps = 24) {
  const box = (type, data) => { const b = Buffer.alloc(8); b.writeUInt32BE(data.length + 8); b.write(type, 4); return Buffer.concat([b, data]); };
  const tkhd = Buffer.alloc(84); tkhd.writeUInt32BE(640 * 65536, 76); tkhd.writeUInt32BE(640 * 65536, 80);
  const mdhd = Buffer.alloc(24); mdhd.writeUInt32BE(fps, 12); mdhd.writeUInt32BE(frames, 16);
  const hdlr = Buffer.alloc(24); hdlr.write('vide', 8);
  return Buffer.concat([box('ftyp', Buffer.from('isom0000')), box('moov', box('trak', Buffer.concat([box('tkhd', tkhd), box('mdia', Buffer.concat([box('mdhd', mdhd), box('hdlr', hdlr)]))]))), box('mdat', Buffer.from('fixture'))]);
}
async function fixture(t, frames = 124) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codebuddy-video-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace with spaces (video)'); await mkdir(cwd);
  const calls = []; let state = 'queued';
  const bytes = metadataFixture(frames);
  const fetchImpl = async (url, options) => {
    const catalogResponse = savedFixtureResponse(url); if (catalogResponse) return catalogResponse;
    calls.push({ url, ...options });
    if (url.endsWith('/prompt')) return Response.json({ prompt_id: id });
    if (url.endsWith('/upload/image')) return Response.json({ name: 'reference.png' });
    if (url.includes('/cancel')) { state = 'cancelled'; return Response.json({ cancelled: true }); }
    if (url.includes('/history/')) return Response.json(state === 'completed' ? { [id]: { status: { completed: true }, outputs: { '92': { images: [{ filename: 'clip.mp4', type: 'output' }] } } } }
      : state === 'cancelled' ? { [id]: { status: { status_str: 'error', messages: [['execution_interrupted', {}]] } } }
        : state === 'failed' ? { [id]: { status: { status_str: 'error', messages: [['execution_error', { exception_message: 'out of memory' }]] } } } : {});
    if (url.endsWith('/queue')) return Response.json({ queue_running: state === 'running' ? [[0, id]] : [], queue_pending: state === 'queued' ? [[0, id]] : [] });
    if (url.includes('/view?')) return new Response(bytes);
    throw new Error(url);
  };
  const options = { cwd, dataDir: root, sessionId: 'video-test', baseUrl: 'http://comfy.test', fetchImpl };
  return { root, cwd, options, calls, bytes, state: s => { state = s; }, tool: comfyuiVideoTool(options) };
}

test('approved video templates preserve original conditioning and frame-grid calculation', () => {
  const text = comfyVideoWorkflow(input, [], id);
  assert.equal(text['140:133'].inputs.value, 5);
  assert.deepEqual(text['140:131'].inputs.length, ['140:132', 1]);
  assert.equal(text['140:131'].inputs.first_frame, undefined);
  const image = comfyVideoWorkflow({ ...input, mode: 'image_to_video', image_path: 'rabbit.png' }, ['uploaded.png'], id);
  assert.deepEqual(image['105:104'].inputs.first_frame, ['114', 0]);
  assert.equal(image['114'].inputs.image, 'uploaded.png');
  assert.throws(() => comfyVideoWorkflow({ ...input, mode: 'image_to_video' }, [], id), /image_path/);
  assert.equal(comfyVideoWorkflow({ ...input, duration_seconds: 100 }, [], id)['140:133'].inputs.value, 100);
  assert.throws(() => comfyVideoWorkflow({ ...input, width: 1344, height: 1344 }, [], id), /resolution/);
});

test('a pending steering input releases a video status observer without resubmitting or changing its budget', async t => {
  const f = await fixture(t);
  const queued = await f.tool.execute(input);
  const before = f.calls.length;
  const wake = new AbortController(); wake.abort();
  const status = await f.tool.execute({ operation: 'status', job_id: id, wait_seconds: 240 }, {
    waitForSteering: async observe => {
      await assert.rejects(observe(wake.signal), { name: 'AbortError' });
      return { released: true };
    },
  });
  assert.equal(status.job_id, queued.job_id);
  assert.equal(status.status, 'queued');
  assert.equal(status.wait_release_reason, 'steer');
  assert.equal(status.waiting_in_background, false);
  assert.equal(status.created_at, queued.created_at);
  assert.equal(f.calls.length, before, 'a preexisting steer must be checked before starting another service request');
});

test('requested long and fractional durations reach the saved workflow and publish completed MP4s', async t => {
  for (const seconds of [20, 30, 60, 20.5]) {
    const f = await fixture(t, seconds * 24);
    const schema = f.tool.inputSchema.properties.duration_seconds;
    assert.equal(schema.maximum, undefined);
    assert.equal(schema.type, 'number');
    const receipt = await f.tool.execute({ ...input, duration_seconds: seconds });
    assert.equal(receipt.status, 'queued');
    const submission = JSON.parse(f.calls.find(c => c.url.endsWith('/prompt')).body);
    assert.equal(submission.prompt['140:133'].inputs.value, seconds);
    assert.deepEqual(submission.prompt['140:131'].inputs.length, ['140:132', 1]);
    f.state('completed');
    const result = await f.tool.execute({ operation: 'status', job_id: id });
    assert.equal(result.status, 'completed');
    assert.equal(result.videos[0].duration_seconds, seconds);
    assert.equal(f.calls.filter(c => c.url.endsWith('/prompt')).length, 1);
  }
});

test('invalid duration is rejected before submission; malformed MP4 durations remain invalid', async t => {
  const f = await fixture(t);
  for (const seconds of [0, -1, NaN, Infinity, '30', null]) {
    await assert.rejects(f.tool.execute({ ...input, duration_seconds: seconds }), /finite positive/);
  }
  assert.equal(f.calls.filter(c => c.url.endsWith('/prompt')).length, 0);
  assert.throws(() => inspectMp4(metadataFixture(0)), /duration/);
  assert.throws(() => inspectMp4(metadataFixture(720, 0)), /duration/);
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
  const library = await readMediaLibrary(f.root, [{ id: f.options.sessionId, cwd: f.cwd }]);
  assert.equal(library.total, 1, 'completed video receipts are visible in the shared media library');
  assert.equal(library.items[0].path, result.videos[0].path);
  assert.equal(library.items[0].available, true);
  assert.equal(library.libraryBytes, f.bytes.length);
  assert.equal(result.videos[0].preview_url, 'http://comfy.test/view?filename=clip.mp4&subfolder=&type=output');
  assert.equal(result.videos[0].markdown, `[Play generated video](<${result.videos[0].path.replaceAll('\\', '/')}>)`);
  assert.equal(path.dirname(result.videos[0].path), path.join(f.cwd, 'generated-videos', id));
  assert.ok(f.calls.every(c => c.url.startsWith('http://comfy.test/')));
  const receiptPath = path.join(f.root, 'video-jobs', Buffer.from('video-test').toString('hex'), `${id}.json`);
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  receipt.videos[0].markdown = `[Play generated video](${receipt.videos[0].preview_url})`;
  await writeFile(receiptPath, JSON.stringify(receipt));
  const remoteLinkReceipt = await comfyuiVideoTool({ ...f.options, fetchImpl: async () => { throw new Error('offline'); } }).execute({ operation: 'status', job_id: id });
  assert.equal(remoteLinkReceipt.videos[0].markdown, result.videos[0].markdown, 'legacy remote links must also resolve to the existing local artifact');
  delete receipt.videos[0].preview_url;
  receipt.videos[0].markdown = '![Generated video](old.mp4)';
  await writeFile(receiptPath, JSON.stringify(receipt));
  const offline = await comfyuiVideoTool({ ...f.options, fetchImpl: async () => { throw new Error('offline'); } }).execute({ operation: 'status', job_id: id });
  assert.equal(offline.status, 'completed');
  assert.equal(offline.videos[0].markdown, result.videos[0].markdown, 'offline playback must not depend on remote metadata repair');
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
    // Old conversations can propose a remembered ID; the native schema must
    // stop that call before any GPU submission. A named call also needs an
    // admitted user request; a direct maintenance call cannot invent one.
    const stale = await driver.callTool(sessionId, 'generate_video', {...input, workflow_id:'saved:minimax_text.json'}, { onPermission: () => true });
    assert.equal(stale.isError, true);
    assert.equal(f.calls.filter(c => c.url.endsWith('/prompt')).length, 0);
    const result = await driver.callTool(sessionId, 'generate_video', {...input, workflow_name:'minimax_text'}, { onPermission: () => true });
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.match(JSON.stringify(result), /admitted current request/);
    assert.equal(f.calls.filter(c => c.url.endsWith('/prompt')).length, 0);
  } finally { await driver.close(); }
});


test('live catalog is session-scoped and publishes completion once without resubmission', async t => {
  const f = await fixture(t);
  await f.tool.execute(input);
  assert.equal(JSON.parse(f.calls.find(call => call.url.endsWith('/prompt')).body).extra_data.preview_method, 'none');
  assert.deepEqual(await comfyuiVideoTool({ ...f.options, sessionId: 'other' }).jobs(), []);
  f.state('running');
  await f.tool.execute({ operation: 'status', job_id: id });
  const active = await f.tool.jobs();
  assert.equal(active[0].status, 'running');
  assert.equal(active[0].videos.length, 0);
  await f.tool.execute({ operation: 'status', job_id: id });
  f.state('completed');
  const [catalog, receipt] = await Promise.all([f.tool.jobs(), f.tool.execute({ operation: 'status', job_id: id })]);
  assert.ok(['running', 'completed'].includes(catalog[0].status));
  const completed = await f.tool.jobs();
  assert.equal(completed[0].status, 'completed');
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.live, undefined); // Preview bytes never enter the model transcript.
  assert.ok((await readFile(completed[0].videos[0].path)).equals(f.bytes));
  assert.equal(f.calls.filter(call => call.url.endsWith('/prompt')).length, 1);
  assert.equal(f.calls.filter(call => call.url.includes('/view?')).length, 1);
});

test('current-request selection overrides a stale legal name and persists its source receipt', async t => {
  const f = await fixture(t); let calls = 0, checks = 0;
  const receipt = { source: 'current_request', request_hash: 'request-2', workflow_id: 'saved:minimax_text.json' };
  const result = await f.tool.execute({ ...input, workflow_name: 'a stale name from history' }, { selectWorkflow: async request => {
    calls++; assert.ok(request.workflows.some(w => w.id === receipt.workflow_id));
    return { workflow_name: 'minimax_text', receipt, assertCurrent: async () => { checks++; } };
  } });
  assert.equal(result.status, 'queued'); assert.equal(result.workflow.id, receipt.workflow_id);
  assert.deepEqual(result.workflow_selection, receipt); assert.equal(calls, 1); assert.equal(checks, 2);
  assert.equal(f.calls.filter(c => c.url.endsWith('/prompt')).length, 1);
});

test('selection failure or steering before final submission never enters the GPU queue', async t => {
  for (const phase of ['selection', 'before-submit']) {
    const f = await fixture(t); let checks = 0;
    const pending = f.tool.execute(input, { selectWorkflow: async () => {
      if (phase === 'selection') throw Error('Selection unavailable');
      return { workflow_name: 'minimax_text', receipt: {}, assertCurrent: async () => { if (++checks === 2) throw Error('Request changed'); } };
    } });
    if (phase === 'selection') await assert.rejects(pending, /Selection unavailable/);
    else { const result = await pending; assert.equal(result.status, 'failed'); assert.match(result.error, /Request changed/); }
    assert.equal(f.calls.filter(c => c.url.endsWith('/prompt')).length, 0);
  }
});

test('saved-file changes while the routing model runs invalidate selection before GPU submission', async t => {
  const f = await fixture(t); let changed = false;
  const tool = comfyuiVideoTool({ ...f.options, fetchImpl: async (url, options) => {
    const response = await f.options.fetchImpl(url, options);
    if (changed && url.includes('/userdata/')) {
      const graph = await response.json(); graph[Object.keys(graph)[0]]._meta = { title: 'changed during routing' };
      return Response.json(graph);
    }
    return response;
  } });
  await assert.rejects(tool.execute(input, { selectWorkflow: async () => {
    changed = true; return { workflow_name: 'minimax_text', receipt: {}, assertCurrent: async () => {} };
  } }), /catalog changed/);
  assert.equal(f.calls.filter(c => c.url.endsWith('/prompt')).length, 0);
});

test('background publication survives a download longer than 15 seconds without restarting it', async t => {
  const f = await fixture(t);
  await f.tool.execute(input); f.state('completed');
  let downloads = 0;
  const tool = comfyuiVideoTool({ ...f.options, fetchImpl: async (url, options) => {
    if (url.includes('/view?')) {
      downloads++;
      await delay(16_000, undefined, { signal: options.signal });
    }
    return f.options.fetchImpl(url, options);
  } });
  assert.equal((await tool.jobs())[0].status, 'queued');
  const result = await tool.execute({ operation: 'status', job_id: id });
  assert.equal(result.status, 'completed');
  assert.equal(downloads, 1);
  assert.deepEqual(await readFile(result.videos[0].path), f.bytes);
  assert.equal(f.calls.filter(c => c.url.endsWith('/prompt')).length, 1);
});

test('Agent status carries prompt-scoped numeric progress without preview frames or false completion', async t => {
  const f = await fixture(t); await f.tool.execute(input); f.state('running');
  const key = mediaStreamKey(f.root, f.options.sessionId, 'video', id);
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  t.after(() => { stopMedia(key); for (const client of server.clients) client.terminate(); server.close(); });
  server.on('connection', socket => {
    socket.send(JSON.stringify({ type: 'progress', data: { prompt_id: id, node: '140:125', value: 4, max: 8 } }));
    socket.send(Buffer.from('ignored-preview'));
    socket.send(JSON.stringify({ type: 'progress', data: { prompt_id: 'other', value: 8, max: 8 } }));
  });
  await watchMedia(key, `http://127.0.0.1:${server.address().port}`, { job_id: id, prompt_id: id });
  for (let i = 0; i < 50 && mediaObservation(key).step !== 4; i++) await delay(10);
  const result = await f.tool.execute({ operation: 'status', job_id: id });
  assert.equal(result.status, 'running');
  assert.equal(result.progress.step, 4);
  assert.equal(result.progress.total, 8);
  assert.equal(result.progress.node, '140:125');
  assert.equal(result.progress.connected, true);
  assert.ok(result.progress.updatedAt > 0);
  assert.equal(result.progress.preview, undefined);
  assert.deepEqual(result.videos, []);
  f.state('completed');
  assert.equal((await f.tool.execute({ operation: 'status', job_id: id })).progress, null);
});

test('catalog recovers an ambiguous submission and clears its stale error without resubmitting', async t => {
  const f = await fixture(t);
  let submissions = 0;
  const tool = comfyuiVideoTool({ ...f.options, fetchImpl: (url, options) => {
    if (url.endsWith('/prompt')) { submissions++; throw new Error('response connection lost'); }
    return f.options.fetchImpl(url, options);
  } });
  const submitted = await tool.execute(input);
  assert.equal(submitted.status, 'submission_unknown');
  assert.match(submitted.error, /connection lost/);
  f.state('running');
  let observed;
  for (let i = 0; i < 50; i++) {
    [observed] = await tool.jobs();
    if (observed.status === 'running') break;
    await delay(20);
  }
  // Wait for any last background refresh before the fixture is removed.
  await tool.execute({ operation: 'status', job_id: id });
  assert.equal(observed.status, 'running');
  assert.equal(observed.error, null);
  assert.equal(submissions, 1);
});

test('background observation does not race an in-flight submission receipt', async t => {
  const f = await fixture(t);
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const tool = comfyuiVideoTool({ ...f.options, fetchImpl: async (url, options) => {
    if (url.endsWith('/prompt')) { started.resolve(); await release.promise; }
    return f.options.fetchImpl(url, options);
  } });
  const pending = tool.execute(input);
  await started.promise;
  try {
    assert.equal((await tool.jobs())[0].status, 'submission_unknown');
    await delay(50);
    assert.equal(f.calls.filter(c => c.url.includes('/history/') || c.url.endsWith('/queue')).length, 0);
  } finally { release.resolve(); }
  assert.equal((await pending).status, 'queued');
  await tool.execute({ operation: 'status', job_id: id });
  assert.equal(f.calls.filter(c => c.url.endsWith('/prompt')).length, 1);
});

test('interrupted output retrieval stays incomplete and recovers without another GPU submission', async t => {
  const f = await fixture(t); await f.tool.execute(input); f.state('completed');
  let downloads = 0;
  const tool = comfyuiVideoTool({ ...f.options, fetchImpl: (url, options) => {
    if (url.includes('/view?') && ++downloads === 1) throw new Error('download connection lost');
    return f.options.fetchImpl(url, options);
  } });
  await assert.rejects(tool.execute({ operation: 'status', job_id: id }), /download connection lost/);
  const [before] = await tool.jobs();
  assert.equal(before.observation_error, true);
  assert.notEqual(before.status, 'completed');
  assert.deepEqual(before.videos, []);
  assert.equal((await tool.execute({ operation: 'status', job_id: id })).status, 'completed');
  const [after] = await tool.jobs();
  assert.equal(after.observation_error, false);
  assert.equal(after.progress, null);
  assert.equal(downloads, 2);
  assert.equal(f.calls.filter(c => c.url.endsWith('/prompt')).length, 1);
});

test('long wait and repeated sidebar reads share low-frequency checks; aborting the wait leaves the server job running', async t => {
  const f = await fixture(t); await f.tool.execute(input); f.state('running');
  const abort = new AbortController();
  const pending = f.tool.execute({ operation: 'status', job_id: id, wait_seconds: 240 }, { signal: abort.signal });
  const cancelled = assert.rejects(pending, /abort/i);
  for (let i = 0; i < 20; i++) { await f.tool.jobs(); await delay(100); }
  assert.equal(f.calls.filter(c => c.url.includes('/history/')).length, 1);
  assert.equal(f.calls.filter(c => c.url.endsWith('/queue')).length, 1);
  abort.abort(); await cancelled;
  assert.equal(f.calls.filter(c => c.url.includes('/cancel')).length, 0);
  assert.equal((await f.tool.execute({ operation: 'status', job_id: id })).status, 'running');
});

test('240-second foreground budget returns background handoff; sidebar later publishes the same job without more model calls', async t => {
  const f = await fixture(t); await f.tool.execute(input); f.state('running');
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const waiting = f.tool.execute({ operation: 'status', job_id: id, wait_seconds: 1 });
  await delay(100); now += 240_001;
  const receipt = await waiting;
  assert.equal(receipt.status, 'running'); assert.equal(receipt.waiting_in_background, true);
  const started = performance.now();
  assert.equal((await f.tool.execute({ operation: 'status', job_id: id, wait_seconds: 240 })).waiting_in_background, true);
  assert.ok(performance.now() - started < 2000, 'a later status call must not begin another four-minute wait');
  f.state('completed'); now += 30_001;
  let completed;
  for (let i = 0; i < 50; i++) { [completed] = await f.tool.jobs(); if (completed.status === 'completed') break; await delay(20); }
  assert.equal(completed.status, 'completed');
  assert.deepEqual(await readFile(completed.videos[0].path), f.bytes);
  assert.equal(f.calls.filter(c => c.url.endsWith('/prompt')).length, 1);
});

test('WebSocket completion wakes a long wait but only history plus saved MP4 can complete it', async t => {
  const f = await fixture(t); await f.tool.execute(input); f.state('running');
  const key = mediaStreamKey(f.root, f.options.sessionId, 'video', id);
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
  t.after(() => { stopMedia(key); for (const client of server.clients) client.terminate(); server.close(); });
  let socket; server.on('connection', client => { socket = client; });
  await watchMedia(key, `http://127.0.0.1:${server.address().port}`, { job_id: id, prompt_id: id });
  const waiting = f.tool.execute({ operation: 'status', job_id: id, wait_seconds: 5 });
  await delay(100);
  socket.send(JSON.stringify({ type: 'execution_success', data: { prompt_id: 'other' } }));
  await delay(50);
  assert.equal(f.calls.filter(c => c.url.includes('/history/')).length, 1);
  socket.send(JSON.stringify({ type: 'executing', data: { prompt_id: id, node: null } }));
  await delay(100);
  assert.equal((await f.tool.jobs())[0].status, 'running', 'terminal hint alone is not completion');
  f.state('completed');
  socket.send(JSON.stringify({ type: 'execution_success', data: { prompt_id: id } }));
  const result = await waiting;
  assert.equal(result.status, 'completed'); assert.equal(result.waiting_in_background, false);
  assert.deepEqual(await readFile(result.videos[0].path), f.bytes);
  assert.equal(f.calls.filter(c => c.url.endsWith('/prompt')).length, 1);
});

test('sidebar checks use 30 seconds with a socket and recover at 10 seconds after disconnect', async t => {
  const f = await fixture(t); await f.tool.execute(input); f.state('running');
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const key = mediaStreamKey(f.root, f.options.sessionId, 'video', id);
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
  t.after(() => { stopMedia(key); for (const client of server.clients) client.terminate(); server.close(); });
  await watchMedia(key, `http://127.0.0.1:${server.address().port}`, { job_id: id, prompt_id: id });
  await f.tool.execute({ operation: 'status', job_id: id });
  const count = () => f.calls.filter(c => c.url.includes('/history/')).length;
  now += 29_999; await f.tool.jobs(); await delay(20); assert.equal(count(), 1);
  now += 2; await f.tool.jobs(); await delay(40); assert.equal(count(), 2);
  stopMedia(key);
  now += 9999; await f.tool.jobs(); await delay(20); assert.equal(count(), 2);
  now += 2; await f.tool.jobs(); await delay(40); assert.equal(count(), 3);
});

test('a slow output download does not extend foreground waiting and later publishes without resubmission', async t => {
  const f = await fixture(t); await f.tool.execute(input); f.state('completed');
  const release = Promise.withResolvers(), started = Promise.withResolvers();
  const tool = comfyuiVideoTool({ ...f.options, fetchImpl: async (url, options) => {
    if (url.includes('/view?')) { started.resolve(); await release.promise; }
    return f.options.fetchImpl(url, options);
  } });
  const before = performance.now();
  const waiting = tool.execute({ operation: 'status', job_id: id, wait_seconds: 1 });
  await started.promise;
  try {
    const pending = await waiting;
    assert.notEqual(pending.status, 'completed'); assert.deepEqual(pending.videos, []);
    assert.ok(performance.now() - before < 2500);
  } finally { release.resolve(); }
  assert.equal((await tool.execute({ operation: 'status', job_id: id })).status, 'completed');
  assert.equal(f.calls.filter(c => c.url.includes('/view?')).length, 1);
  assert.equal(f.calls.filter(c => c.url.endsWith('/prompt')).length, 1);
});
