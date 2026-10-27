import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, watch } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { comfyuiMediaTool } from '../comfyui-tool.mjs';

const id = '7901e4fa-597f-4a31-bd8b-71431bcce781';
const deferred = () => Promise.withResolvers();
async function fixture(t, initial = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codebuddy-media-cancel-')));
  const sessionId = 'cancellation-regression';
  const records = path.join(root, 'image-jobs', Buffer.from(sessionId).toString('hex'));
  await mkdir(records, { recursive: true });
  const file = path.join(records, `${id}.json`);
  await writeFile(file, JSON.stringify({ job_id: id, prompt_id: id, server: 'http://fixture.invalid',
    status: 'running', created_at: '2026-10-27T00:00:00.000Z', input: {}, ...initial }));
  const png = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.write('IHDR', 12); png.writeUInt32BE(64, 16); png.writeUInt32BE(64, 20);
  const f = { root, file, state: 'running', calls: [], onHistory: null, onCancel: null };
  const fetchImpl = async (url, options = {}) => {
    const request = new URL(url), route = request.pathname;
    assert.equal(request.hostname, 'fixture.invalid');
    options.signal?.throwIfAborted();
    f.calls.push({ route, method: options.method ?? 'GET' });
    if (route === `/history/${id}`) {
      const snapshot = f.state;
      await f.onHistory?.();
      return Response.json(snapshot === 'completed'
        ? { [id]: { status: { completed: true }, outputs: { save: { images: [{ filename: 'result.png', type: 'output' }] } } } }
        : snapshot === 'interrupted'
          ? { [id]: { status: { status_str: 'error', messages: [['execution_interrupted', {}]] } } }
          : snapshot === 'failed'
            ? { [id]: { status: { status_str: 'error', messages: [['execution_error', { exception_message: 'GPU OOM' }]] } } }
            : {});
    }
    if (route === '/queue') return Response.json({ queue_running: f.state === 'running' ? [[0, id]] : [], queue_pending: [] });
    if (route === `/api/jobs/${id}/cancel`) {
      assert.equal(options.method, 'POST');
      await f.onCancel?.();
      return Response.json({ cancelled: true });
    }
    if (route === '/view') return new Response(png);
    throw new Error(`Unexpected fixture request ${route}`);
  };
  f.options = { cwd: root, dataDir: root, sessionId, fetchImpl,
    statfsImpl: async () => ({ bavail: 1_000_000, bsize: 4096 }) };
  f.tool = comfyuiMediaTool(f.options);
  f.saved = async () => JSON.parse(await readFile(file, 'utf8'));
  t.after(async () => {
    assert.equal(path.dirname(root), await realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('codebuddy-media-cancel-'));
    await rm(root, { recursive: true, force: true });
  });
  return f;
}
async function waitForCancelMarker(f, signal) {
  for await (const event of watch(path.dirname(f.file), { signal })) {
    if (event.filename !== path.basename(f.file)) continue;
    const saved = await f.saved().catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (saved?.cancel_requested === true) return;
  }
}

test('stale UI refresh preserves accepted cancellation and classifies interruption using the latest receipt', { timeout: 3000 }, async t => {
  const f = await fixture(t), postEntered = deferred(), releasePost = deferred(), historyEntered = deferred(), releaseHistory = deferred();
  let histories = 0;
  f.onCancel = async () => { f.state = 'interrupted'; postEntered.resolve(); await releasePost.promise; };
  f.onHistory = async () => { if (++histories === 2) { historyEntered.resolve(); await releaseHistory.promise; } };
  t.after(() => { releasePost.resolve(); releaseHistory.resolve(); });
  const cancellation = f.tool.execute({ operation: 'cancel', job_id: id });
  await postEntered.promise;
  const otherInstance = comfyuiMediaTool(f.options);
  await otherInstance.jobs();
  await historyEntered.promise;
  const joined = otherInstance.execute({ operation: 'status', job_id: id });
  const marker = waitForCancelMarker(f, AbortSignal.timeout(2000));
  releasePost.resolve();
  await marker;
  releaseHistory.resolve();
  const [cancelled, status] = await Promise.all([cancellation, joined]);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancellation_confirmed, true);
  assert.equal(status.status, 'cancelled');
  assert.equal((await f.saved()).cancel_requested, true);
});

test('a late cancel acknowledgement does not overwrite a completion published while POST was pending', { timeout: 3000 }, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  f.onCancel = async () => { entered.resolve(); await release.promise; };
  t.after(() => release.resolve());
  const cancellation = f.tool.execute({ operation: 'cancel', job_id: id });
  await entered.promise;
  f.state = 'completed';
  const completed = await f.tool.execute({ operation: 'status', job_id: id });
  assert.equal(completed.status, 'completed');
  release.resolve();
  const cancelled = await cancellation, saved = await f.saved();
  assert.equal(cancelled.status, 'completed');
  assert.equal(cancelled.cancellation_confirmed, false);
  assert.equal(saved.status, 'completed');
  assert.equal(saved.cancel_requested, true);
  assert.deepEqual(saved.images, completed.images);
  assert.equal(f.calls.filter(call => call.route === '/view').length, 1);
});

test('interruption observed before cancel acknowledgement is rechecked from authoritative history', { timeout: 3000 }, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  f.onCancel = async () => { f.state = 'interrupted'; entered.resolve(); await release.promise; };
  t.after(() => release.resolve());
  const cancellation = f.tool.execute({ operation: 'cancel', job_id: id });
  await entered.promise;
  assert.equal((await f.tool.execute({ operation: 'status', job_id: id })).status, 'failed');
  release.resolve();
  const cancelled = await cancellation;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancellation_confirmed, true);
  assert.equal((await f.saved()).cancel_requested, true);
});

test('accepted cancellation does not turn an authoritative execution error into a cancelled job', { timeout: 3000 }, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  f.onCancel = async () => { f.state = 'failed'; entered.resolve(); await release.promise; };
  t.after(() => release.resolve());
  const cancellation = f.tool.execute({ operation: 'cancel', job_id: id });
  await entered.promise;
  assert.equal((await f.tool.execute({ operation: 'status', job_id: id })).status, 'failed');
  release.resolve();
  const failed = await cancellation;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.cancellation_confirmed, false);
  assert.match(failed.error, /GPU OOM/);
  assert.equal((await f.saved()).cancel_requested, true);
});

test('a late cancel acknowledgement preserves a known failure when remote history has disappeared', { timeout: 3000 }, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  f.onCancel = async () => { entered.resolve(); await release.promise; };
  t.after(() => release.resolve());
  const cancellation = f.tool.execute({ operation: 'cancel', job_id: id });
  await entered.promise;
  f.state = 'failed';
  const failure = await f.tool.execute({ operation: 'status', job_id: id });
  assert.equal(failure.status, 'failed');
  f.state = 'absent';
  release.resolve();
  const cancelled = await cancellation, saved = await f.saved();
  assert.equal(cancelled.status, 'failed');
  assert.equal(cancelled.error, failure.error);
  assert.equal(cancelled.cancellation_confirmed, false);
  assert.equal(saved.status, 'failed');
  assert.equal(saved.cancel_requested, true);
});

test('accepted cancellation plus queue absence stays uncertain and later completion remains publishable', async t => {
  const f = await fixture(t);
  f.onCancel = async () => { f.state = 'absent'; };
  const cancelled = await f.tool.execute({ operation: 'cancel', job_id: id });
  assert.equal(cancelled.status, 'unavailable');
  assert.equal(cancelled.cancellation_confirmed, false);
  assert.equal((await f.saved()).cancel_requested, true);
  f.state = 'completed';
  const completed = await f.tool.execute({ operation: 'status', job_id: id });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.images.length, 1);
  assert.equal(f.calls.filter(call => call.route === `/api/jobs/${id}/cancel`).length, 1);
  assert.ok(f.calls.every(call => !['/prompt', '/interrupt'].includes(call.route)));
});

test('explicit status can reconcile an older cancelled receipt with a completed remote output', async t => {
  const f = await fixture(t, { status: 'cancelled', cancel_requested: true });
  f.state = 'completed';
  const completed = await f.tool.execute({ operation: 'status', job_id: id });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.images.length, 1);
  assert.equal((await f.saved()).cancel_requested, true);
  assert.ok(f.calls.every(call => call.method === 'GET'));
});

test('explicit recheck does not infer cancellation from an older cancelled receipt and a missing remote job', async t => {
  const f = await fixture(t, { status: 'cancelled', cancel_requested: true });
  f.state = 'absent';
  assert.equal((await f.tool.execute({ operation: 'status', job_id: id })).status, 'unavailable');
  f.state = 'interrupted';
  assert.equal((await f.tool.execute({ operation: 'status', job_id: id })).status, 'cancelled');
});
