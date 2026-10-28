import { savedFixtureResponse } from './comfyui-catalog-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { comfyuiTool, comfyWorkflow, comfyuiUrl } from '../comfyui-tool.mjs';
import { comfyuiVideoTool } from '../comfyui-video-tool.mjs';
import { validatePreference } from '../settings.mjs';
import { createHarnessDriver } from '../harness/index.mjs';

const id = 'bafe8f1d-310a-4e29-92e7-73e7ba920ade';
async function fixture(t, saveNode = '461') {
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
    const catalogResponse = savedFixtureResponse(url); if (catalogResponse) return catalogResponse;
    calls.push({ url, ...options });
    if (url.endsWith('/prompt')) return Response.json({ prompt_id: id });
    if (url.includes('/upload/image')) return Response.json({ name: 'reference.png', subfolder: 'input', type: 'input' });
    if (url.includes('/cancel')) { state = 'cancelled'; return Response.json({ cancelled: true }); }
    if (url.includes('/history/')) return Response.json(state === 'completed' ? { [id]: { status: { completed: true, status_str: 'success' }, outputs: { [saveNode]: { images: [{ filename: '../../remote.png', subfolder: 'CodeBuddy', type: 'output' }] } } } }
      : state === 'cancelled' ? { [id]: { status: { status_str: 'error', messages: [['execution_interrupted', {}]] } } }
        : state === 'failed' ? { [id]: { status: { status_str: 'error', messages: [['execution_error', { exception_message: 'GPU OOM' }]] } } } : {});
    if (url.endsWith('/queue')) return Response.json({ queue_running: state === 'running' ? [[1, id]] : [], queue_pending: state === 'queued' ? [[1, id]] : [] });
    if (url.includes('/view?')) return new Response(png);
    throw new Error(`Unexpected request ${url}`);
  };
  const options = { cwd, dataDir: root, sessionId: 'test-session', baseUrl: 'http://comfy.test', fetchImpl };
  return { root, cwd, png, calls, options, tool: comfyuiTool(options), state: value => { state = value; } };
}
const generate = { operation: 'generate', prompt: 'A watercolor mountain', request_id: id };

test('an orphaned preparing record is observed by its original ID without resubmission', async t => {
  const f = await fixture(t);
  await f.tool.execute(generate);
  const file = path.join(f.root, 'image-jobs', Buffer.from(f.options.sessionId).toString('hex'), `${id}.json`);
  const record = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...record, status: 'preparing' }));
  f.state('failed');
  const restored = comfyuiTool(f.options);
  assert.equal((await restored.jobs())[0].status, 'preparing');
  assert.equal((await restored.execute({ operation: 'status', job_id: id })).status, 'failed');
  assert.equal(f.calls.filter(call => call.url.endsWith('/prompt')).length, 1);
});

test('a stalled observation expires its running display without cancelling or replacing the job', async t => {
  const f = await fixture(t);
  await f.tool.execute(generate);
  f.state('failed');
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const tool = comfyuiTool({ ...f.options, fetchImpl: async (url, options) => {
    if (url.includes('/history/')) await barrier;
    return f.options.fetchImpl(url, options);
  } });
  try {
    assert.equal((await tool.jobs())[0].observation_error, false);
    now += 16_000;
    const stale = (await tool.jobs())[0];
    assert.equal(stale.observation_error, true);
    assert.equal(stale.status, 'queued');
    assert.equal(f.calls.filter(call => call.url.endsWith('/prompt')).length, 1);
    assert.equal(f.calls.some(call => call.url.includes('/cancel') || call.url.endsWith('/interrupt')), false);
  } finally { release(); }
  const final = await tool.execute({ operation: 'status', job_id: id });
  assert.equal(final.status, 'failed');
  assert.equal((await tool.jobs())[0].observation_error, false);
});

test('pre-template queued receipts still download their original output without submitting a replacement', async t => {
  const f = await fixture(t, 'save');
  const records = path.join(f.root, 'image-jobs', Buffer.from(f.options.sessionId).toString('hex'));
  await mkdir(records, { recursive: true });
  await writeFile(path.join(records, `${id}.json`), JSON.stringify({
    job_id: id, prompt_id: id, server: f.options.baseUrl, status: 'queued',
    created_at: new Date().toISOString(), input: generate,
  }));
  f.state('completed');
  const receipt = await f.tool.execute({ operation: 'status', job_id: id });
  assert.equal(receipt.status, 'completed');
  assert.deepEqual(await readFile(receipt.images[0].path), f.png);
  assert.equal(f.calls.filter(call => call.url.endsWith('/prompt')).length, 0);
});

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
  assert.equal(JSON.parse(f.calls.find(x => x.url.endsWith('/prompt')).body).extra_data.preview_method, 'none');
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

test('business names are display-only, survive status/cancel and recreation, and idempotent retries retain the original name', async t => {
  const f = await fixture(t);
  const submitted = await f.tool.execute({ ...generate, display_name: '  品牌欢迎插画  ' });
  assert.equal(submitted.display_name, '品牌欢迎插画');
  assert.equal((await f.tool.execute({ ...generate, display_name: 'Do not rename' })).display_name, submitted.display_name);
  assert.equal((await f.tool.execute(generate)).display_name, submitted.display_name);
  const records = path.join(f.root, 'image-jobs', Buffer.from(f.options.sessionId).toString('hex'));
  const saved = JSON.parse(await readFile(path.join(records, `${id}.json`), 'utf8'));
  assert.equal(saved.display_name, submitted.display_name);
  assert.deepEqual(saved.input, generate);
  assert.ok(!JSON.stringify(JSON.parse(f.calls.find(call => call.url.endsWith('/prompt')).body)).includes(submitted.display_name));
  const restored = comfyuiTool(f.options);
  f.state('running');
  assert.equal((await restored.execute({ operation: 'status', job_id: id })).display_name, submitted.display_name);
  const cancelled = await restored.execute({ operation: 'cancel', job_id: id, display_name: 'Do not rename during cancel' });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.display_name, submitted.display_name);
  assert.equal(cancelled.failure_info, undefined);
  assert.equal((await restored.jobs())[0].display_name, submitted.display_name);
  assert.equal(f.calls.filter(call => call.url.endsWith('/prompt')).length, 1);
});

test('video business names use the same optional metadata contract without changing video inputs', async t => {
  const f = await fixture(t), tool = comfyuiVideoTool(f.options);
  const input = { ...generate, mode: 'text_to_video' };
  assert.equal(tool.inputSchema.properties.display_name.type, undefined);
  assert.equal((await tool.execute({ ...input, display_name: '  门店促销短片  ' })).display_name, '门店促销短片');
  assert.equal((await tool.execute({ ...input, display_name: 'A different label' })).display_name, '门店促销短片');
  const cancelled = await tool.execute({ operation: 'cancel', job_id: id });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.failure_info, undefined);
  assert.equal((await tool.jobs())[0].display_name, '门店促销短片');
  const saved = JSON.parse(await readFile(path.join(f.root, 'video-jobs', Buffer.from(f.options.sessionId).toString('hex'), `${id}.json`), 'utf8'));
  assert.deepEqual(saved.input, input);
  assert.equal(f.calls.filter(call => call.url.endsWith('/prompt')).length, 1);
});

test('invalid optional names degrade without blocking execution or retroactively naming legacy records', async t => {
  for (const value of [42, { name: 'wrong type' }, '', 'x'.repeat(81), 'two\nlines', '\u202Ehidden']) {
    await t.test(JSON.stringify(value), async child => {
      const f = await fixture(child);
      const submitted = await f.tool.execute({ ...generate, display_name: value });
      assert.equal(submitted.status, 'queued');
      assert.equal(submitted.display_name, undefined);
      assert.equal((await f.tool.execute({ ...generate, display_name: 'Later name' })).display_name, undefined);
      assert.equal(f.calls.filter(call => call.url.endsWith('/prompt')).length, 1);
    });
  }
  await t.test('Unicode length and schema allow host degradation', async child => {
    const f = await fixture(child);
    const name = '🐼'.repeat(80);
    assert.equal((await f.tool.execute({ ...generate, display_name: name })).display_name, name);
    assert.equal(f.tool.inputSchema.properties.display_name.type, undefined);
  });
});

test('remote execution preserves structured failure facts without deriving a code from message text', async t => {
  for (const code of ['dimension_mismatch', undefined]) {
    await t.test(code ?? 'uncoded', async child => {
      const f = await fixture(child); await f.tool.execute(generate);
      const details = { node_type: 'KSampler', exception_type: 'RuntimeError', exception_message: 'GPU OOM or dimensions: unclassified original text', ...(code ? { error_code: code } : {}) };
      const tool = comfyuiTool({ ...f.options, fetchImpl: (url, options) => url.includes('/history/')
        ? Promise.resolve(Response.json({ [id]: { status: { status_str: 'error', messages: [['execution_error', details]] } } }))
        : f.options.fetchImpl(url, options) });
      const failed = await tool.execute({ operation: 'status', job_id: id });
      assert.equal(failed.status, 'failed');
      assert.deepEqual(failed.failure_info, { stage: 'remote_execution', source: 'comfyui', node_type: 'KSampler', exception_type: 'RuntimeError', message: details.exception_message, ...(code ? { error_code: code } : {}) });
      assert.equal(failed.error, `KSampler: ${details.exception_message}`);
      assert.deepEqual((await comfyuiTool(f.options).jobs())[0].failure_info, failed.failure_info);
    });
  }
});

test('structured failure identities stay bounded without converting malformed fields into shared error codes', async t => {
  const f = await fixture(t); await f.tool.execute(generate);
  const details = { node_type: 'K'.repeat(161), exception_type: { invalid: true }, error_code: 'wrong\ncode', exception_message: 'original\nerror '.repeat(300) };
  const tool = comfyuiTool({ ...f.options, fetchImpl: (url, options) => url.includes('/history/')
    ? Promise.resolve(Response.json({ [id]: { status: { status_str: 'error', messages: [['execution_error', details]] } } }))
    : f.options.fetchImpl(url, options) });
  const failed = await tool.execute({ operation: 'status', job_id: id });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.failure_info, { stage: 'remote_execution', source: 'comfyui', message: details.exception_message.slice(0, 2500) });
  assert.equal(failed.error, `${details.node_type}: ${details.exception_message.trim()}`.slice(0, 2500));
});

test('submission rejection and ambiguous transport keep their existing outcomes and structured domains', async t => {
  await t.test('HTTP rejection', async child => {
    const f = await fixture(child);
    const tool = comfyuiTool({ ...f.options, fetchImpl: (url, options) => url.endsWith('/prompt')
      ? Promise.resolve(Response.json({ error: { message: 'Workflow rejected' }, error_code: 'invalid_workflow' }, { status: 400 }))
      : f.options.fetchImpl(url, options) });
    const failed = await tool.execute(generate);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failure_info.stage, 'submission');
    assert.equal(failed.failure_info.source, 'comfyui');
    assert.equal(failed.failure_info.http_status, 400);
    assert.equal(failed.failure_info.error_code, 'invalid_workflow');
    assert.match(failed.error, /Workflow rejected/);
  });
  await t.test('ambiguous submission', async child => {
    const f = await fixture(child);
    const tool = comfyuiTool({ ...f.options, fetchImpl: (url, options) => {
      if (url.endsWith('/prompt')) throw new Error('Response connection lost');
      return f.options.fetchImpl(url, options);
    } });
    const uncertain = await tool.execute(generate);
    assert.equal(uncertain.status, 'submission_unknown');
    assert.equal(uncertain.failure_info, undefined);
    assert.deepEqual(uncertain.observation_error_info, { stage: 'submission', source: 'comfyui', message: 'Response connection lost' });
    assert.equal(uncertain.error, 'Response connection lost');
    assert.equal((await tool.execute({ operation: 'status', job_id: id })).status, 'queued');
    assert.equal((await tool.jobs())[0].observation_error, false);
    await tool.execute({ operation: 'status', job_id: id });
  });
});

test('query, retrieval, validation and publication errors remain recoverable observations, not generation failure', async t => {
  for (const stage of ['query', 'output_retrieval', 'output_validation', 'output_publication']) {
    await t.test(stage, async child => {
      const f = await fixture(child); await f.tool.execute(generate); f.state('completed');
      let fail = true;
      const tool = comfyuiTool({ ...f.options,
        statfsImpl: async () => ({ bavail: fail && stage === 'output_publication' ? 0 : 2 * 1024 ** 3, bsize: 1 }),
        fetchImpl: (url, options) => {
          if (fail && ((stage === 'query' && url.includes('/history/')) || (stage === 'output_retrieval' && url.includes('/view?')))) throw new Error('Temporary observation trouble');
          if (fail && stage === 'output_validation' && url.includes('/view?')) return Promise.resolve(new Response('not PNG'));
          return f.options.fetchImpl(url, options);
        },
      });
      await assert.rejects(tool.execute({ operation: 'status', job_id: id }));
      const snapshot = (await tool.jobs())[0];
      assert.equal(snapshot.observation_error, true);
      assert.equal(snapshot.observation_error_info.stage, stage);
      assert.equal(snapshot.observation_error_info.source, ['query', 'output_retrieval'].includes(stage) ? 'comfyui' : 'host');
      assert.equal(typeof snapshot.observation_error_info.message, 'string');
      assert.equal(snapshot.status, 'queued');
      assert.equal(snapshot.failure_info, undefined);
      const persisted = JSON.parse(await readFile(path.join(f.root, 'image-jobs', Buffer.from(f.options.sessionId).toString('hex'), `${id}.json`), 'utf8'));
      assert.equal(persisted.status, 'queued');
      assert.equal(persisted.observation_error_info, undefined);
      await assert.rejects(tool.execute({ operation: 'status', job_id: id }));
      fail = false;
      const completed = await tool.execute({ operation: 'status', job_id: id });
      assert.equal(completed.status, 'completed');
      assert.equal(completed.failure_info, undefined);
      assert.equal(completed.observation_error_info, undefined);
      assert.equal((await tool.jobs())[0].observation_error, false);
      assert.equal(f.calls.filter(call => call.url.endsWith('/prompt')).length, 1);
    });
  }
});
test('reference editing uploads actual workspace bytes and builds transparent pose request without pet-only constraints', async t => {
  const f = await fixture(t); await writeFile(path.join(f.cwd, 'reference.png'), f.png);
  await f.tool.execute({ ...generate, reference_images: ['reference.png'], transparent_background: true, width: 1536 });
  const upload = f.calls.find(x => x.url.endsWith('/upload/image')).body;
  assert.deepEqual(Buffer.from(await upload.get('image').arrayBuffer()), f.png);
  const graph = JSON.parse(f.calls.find(x => x.url.endsWith('/prompt')).body).prompt;
  assert.deepEqual(graph['459:474'].inputs['images.image_1'], ['470', 0]);
  assert.match(graph['459:474'].inputs.prompt, /watercolor mountain/);
  assert.match(graph['459:474'].inputs.prompt, /alpha channel/);
  assert.equal(graph['13'].inputs.aspect_ratio, '3:2 (Photo)');
  assert.equal(graph['459:468'].inputs.switch, true);
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
  const uncertain = comfyuiTool({ ...f.options, fetchImpl: async (url, options) => { if (url.endsWith('/prompt')) throw new Error('Connection lost'); return f.options.fetchImpl(url, options); } });
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
    const result = await driver.callTool(sessionId, f.tool.name, { ...generate, display_name: 42 }, { onPermission: () => true });
    assert.equal(result.isError, false, JSON.stringify(result)); assert.match(JSON.stringify(result), /queued/);
  } finally { await driver.close(); }
});


test('preview catalog returns durable receipts while a service observation is still pending', { timeout: 3000 }, async t => {
  const f = await fixture(t);
  await f.tool.execute(generate);
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  let observed = false;
  const slow = comfyuiTool({ ...f.options, fetchImpl: async (url, options) => {
    if (url.includes('/history/')) { observed = true; await barrier; }
    return f.options.fetchImpl(url, options);
  } });
  try {
    const snapshot = await slow.jobs();
    assert.equal(snapshot[0].status, 'queued');
    assert.equal(snapshot[0].workflow.id, 'saved:qwen_image.json');
    assert.equal(observed, true);
  } finally { release(); }
  await slow.execute({ operation: 'status', job_id: id });
});
