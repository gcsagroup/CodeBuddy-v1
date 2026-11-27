import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarnessDriver } from '../harness/index.mjs';
import { createConversationDriver } from '../conversation-driver.mjs';
import { Compat } from '../compat.mjs';
import { DesktopCoordinator } from '../desktop-coordinator.mjs';
import { openStore } from '../store.mjs';
import { savedFixtureResponse } from './comfyui-catalog-fixture.mjs';
import { replyToNoActionReview } from '../harness/test/review-fixture.mjs';

const textOf = message => typeof message.content === 'string' ? message.content
  : (message.content ?? []).map(part => part.text ?? '').join('\n');
const deferred = () => Promise.withResolvers();

function reply(body, res, tool, text = 'Fixture request finished.') {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function',
    function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : { role: 'assistant', content: text };
  res.end('data: ' + JSON.stringify({ id: randomUUID(), model: body.model,
    choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
}

// Real Compat, native Harness and generate_image, with only loopback providers.
// No native desktop, GPU, account credentials, or globally patched fetch is used.
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codebuddy-steering-media-')));
  const dataDir = join(root, 'host');
  const controls = [], calls = [], models = [], failures = [], notifications = [], running = [];
  const png = await readFile(new URL('../../ui/desktop/src/pets/assets/red-panda/sprites.png', import.meta.url));
  let host;
  const remote = createServer(async (req, res) => {
    const json = value => { if (!res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value)); };
    const url = new URL(req.url, 'http://fixture');
    try {
      const catalog = savedFixtureResponse(req.url);
      if (catalog) return json(await catalog.json());
      if (url.pathname.endsWith('/models')) return json({ data: [{ id: 'fixture' }] });
      if (url.pathname.endsWith('/openapi.json') || url.pathname === '/ws') { res.writeHead(404).end(); return; }
      if (url.pathname === '/view') {
        calls.push({ route: '/view', at: Date.now(), bytes: png.length });
        res.writeHead(200, { 'content-type': 'image/png' }).end(png); return;
      }
      if (url.pathname === '/queue') return json({ queue_running: controls.filter(c => c.submitted && c.state === 'running').map(c => [0, c.id]), queue_pending: [] });
      if (url.pathname.startsWith('/history/')) {
        const id = url.pathname.split('/').at(-1), control = controls.find(c => c.id === id);
        assert.ok(control, 'query must refer to a fixture-owned job');
        calls.push({ route: url.pathname, at: Date.now() });
        control.waitEnteredAt ??= Date.now();
        control.waitEntered.resolve();
        if (control.blockHistory) {
          control.blockHistory = false;
          control.blockedResponse = res;
          await Promise.race([control.release.promise, new Promise(resolve => res.once('close', resolve))]);
          calls.push({ route: '/fixture/history-released', at: Date.now(), id: control.id, state: control.state, destroyed: res.destroyed });
        }
        if (control.state === 'observation_error') { res.writeHead(503).end(JSON.stringify({ error: 'History unavailable' })); return; }
        if (control.state === 'completed') return json({ [id]: { status: { completed: true, status_str: 'success' },
          outputs: { [control.saveNode]: { images: [{ filename: 'fixture.png', type: 'output' }] } } } });
        if (control.state === 'interrupted') return json({ [id]: { status: { status_str: 'error', messages: [['execution_interrupted', {}]] } } });
        if (control.state === 'failed') return json({ [id]: { status: { status_str: 'error', messages: [['execution_error', { exception_message: 'Isolated fixture settled' }]] } } });
        return json({});
      }
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if (url.pathname === '/prompt') {
        const control = controls.find(c => c.id === body.prompt_id);
        assert.ok(control, 'submission must have an owned request identity');
        control.submitted = true;
        [control.saveNode] = Object.entries(body.prompt).find(([, node]) => ['SaveImage', 'SaveImageAdvanced'].includes(node.class_type)) ?? [];
        assert.ok(control.saveNode, 'saved workflow must contain an image output');
        calls.push({ route: '/prompt', id: control.id, at: Date.now() });
        return json({ prompt_id: control.id });
      }
      if (/^\/api\/jobs\/[^/]+\/cancel$/.test(url.pathname)) {
        const id = url.pathname.split('/')[3], control = controls.find(c => c.id === id);
        assert.ok(control, 'cancellation must name an owned fixture job');
        calls.push({ route: url.pathname, id, at: Date.now() });
        control.state = 'interrupted';
        return json({ cancelled: true });
      }
      assert.equal(url.pathname, '/v1/chat/completions', 'all model traffic stays on the local provider');
      if (replyToNoActionReview(body, res)) return;
      if (body.tools?.some(tool => tool.function?.name === 'select_workflow')) {
        const input = JSON.parse(textOf(body.messages.findLast(message => message.role === 'user')));
        const selected = input.workflows.find(workflow => workflow.compatible && workflow.dependencies_available);
        assert.ok(selected);
        return reply(body, res, { name: 'select_workflow', args: { workflow_id: selected.id, mode: selected.mode,
          reason: 'Compatible fixture workflow', image_count: 1, images_only: true, single_media_only: true } });
      }
      const control = controls.find(c => body.messages?.some(message => message.role === 'user' && textOf(message) === c.task));
      // Titles and optional image interpretation are not main Agent requests.
      if (!control || !body.tools?.some(tool => tool.function?.name === 'search_mcp_tools'))
        return reply(body, res, null, 'Local fixture observation.');
      models.push({ body, at: Date.now(), id: control.id });
      if (body.messages.some(message => message.role === 'user' && textOf(message) === control.correction)) {
        control.nextModelAt ??= Date.now(); control.nextModel.resolve(body);
      }
      const start = body.messages.findIndex(message => message.role === 'user' && textOf(message) === control.task);
      const results = body.messages.slice(start + 1).filter(message => message.role === 'tool');
      if (results.length === 0) return reply(body, res, { name: 'search_mcp_tools', args: { names: ['generate_image'] } });
      if (results.length === 1) return reply(body, res, { name: 'generate_image', args: {
        operation: 'generate', request_id: control.id, prompt: 'One isolated fixture image', width: 512, height: 512, seed: 1 } });
      if (results.length === 2 && control.statusWait !== null) return reply(body, res, { name: 'generate_image', args: {
        operation: 'status', job_id: control.id, wait_seconds: control.statusWait } });
      if (results.length === 3 && control.collectAfterSteer) {
        await control.collectResult.promise;
        return reply(body, res, { name: 'generate_image', args: { operation: 'status', job_id: control.id, wait_seconds: 0 } });
      }
      return reply(body, res, null);
    } catch (error) {
      failures.push(error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + remote.address().port;
  t.after(async () => {
    for (const control of controls) { control.release.resolve(); control.collectResult.resolve(); }
    await host?.close();
    await Promise.allSettled(running);
    remote.closeAllConnections(); await new Promise(resolve => remote.close(resolve));
    assert.equal(dirname(root), await realpath(tmpdir()));
    assert.ok(basename(root).startsWith('codebuddy-steering-media-'));
    await rm(root, { recursive: true, force: true });
  });
  const store = await openStore(dataDir);
  await store.update(state => {
    state.providers = [{ id: 'fixture', engine: 'openai_compatible', apiUrl: baseUrl + '/v1', models: ['fixture'], requiresAuth: false }];
    state.defaults = { providerId: 'fixture', modelId: 'fixture' };
    state.preferences.comfyuiBaseUrl = baseUrl;
  });
  const native = await createHarnessDriver({ dataDir: join(root, 'native'), cwd: root });
  host = new Compat(store, createConversationDriver(native, store));
  // Prompt/steer call preparePrompt even without CU tools. Keep its lease and
  // pause markers private, too; never inspect or resume the user's desktop.
  host.desktop = new DesktopCoordinator({ directory: join(root, 'desktop-control') });
  await host.initialize();
  const connection = { sessionIds: new Set(), notify(method, params) { notifications.push({ method, params }); },
    async ask(method, params) {
      assert.equal(method, 'session/request_permission');
      const selected = params.options.find(option => option.kind === 'allow_always') ?? params.options.find(option => option.kind === 'allow_once');
      assert.ok(selected); return { outcome: { outcome: 'selected', optionId: selected.optionId } };
    } };
  const rpc = (method, params) => host.request(method, params, connection);
  return { calls, models, failures, notifications, png, host,
    async start(label, statusWait = 4, { collectAfterSteer = false, holdHistory = true } = {}) {
      const { sessionId } = await rpc('session/new', { cwd: root, mcpServers: [], _meta: { enabledExtensions: ['developer'] } });
      const control = { id: randomUUID(), sessionId, statusWait, collectAfterSteer, collectResult: deferred(), state: 'running', submitted: false,
        task: 'Create exactly one isolated media fixture image: ' + label,
        correction: 'Also preserve the original image task and include correction ' + label,
        blockHistory: holdHistory && statusWait !== null, waitEntered: deferred(), release: deferred(), nextModel: deferred() };
      controls.push(control);
      control.receipt = () => readFile(join(dataDir, 'image-jobs', Buffer.from(sessionId).toString('hex'), control.id + '.json'), 'utf8').then(JSON.parse);
      control.running = rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: control.task }] });
      control.running.catch(() => {}); running.push(control.running);
      return control;
    },
    async steer(control) {
      const active = host.active.get(control.sessionId), expectedRunId = active?.run?.runId ?? active?.desktopControlToken;
      assert.ok(expectedRunId);
      control.sentAt = Date.now();
      await rpc('_goose/unstable/session/steer', { sessionId: control.sessionId, expectedRunId,
        prompt: [{ type: 'text', text: control.correction }],
        _meta: { 'codebuddy/input-mode': 'steer', 'codeagentpro/source-message-id': 'media-steer-' + control.id } });
      control.admittedAt = Date.now();
    },
    stop: control => rpc('session/cancel', { sessionId: control.sessionId }),
    jobs: control => rpc('_codebuddy/media/jobs', { sessionId: control.sessionId }),
  };
}

async function assertFreshWait(control) {
  await control.waitEntered.promise;
  const receipt = await control.receipt();
  assert.ok(['queued', 'running'].includes(receipt.status), JSON.stringify(receipt));
  assert.equal(receipt.prompt_id, control.id);
  assert.ok(Date.now() - Date.parse(receipt.created_at) < (control.statusWait || 240) * 1000,
    'fixture must enter status while its actual foreground budget is still live');
}

function assertOneSubmissionAndNoCancel(f, control) {
  assert.equal(f.calls.filter(call => call.route === '/prompt' && call.id === control.id).length, 1);
  assert.equal(f.calls.some(call => call.route.includes('/cancel')), false);
}

function assertContinuation(body, control, statusIndex = 0) {
  const user = body.messages.filter(message => message.role === 'user').map(textOf);
  assert.ok(user.includes(control.task), 'next real provider request retains the original request');
  assert.equal(user.filter(text => text === control.correction).length, 1);
  const statusCalls = body.messages.filter(message => message.role === 'assistant')
    .flatMap(message => message.tool_calls ?? [])
    .map(call => ({ call, input: JSON.parse(call.function.arguments) }))
    .filter(({ input }) => input.operation === 'status' && input.job_id === control.id);
  assert.equal(statusCalls.length, statusIndex + 1, 'only explicitly proposed status calls may be recorded');
  const results = body.messages.filter(message => message.role === 'tool' &&
    message.tool_call_id === statusCalls[statusIndex].call.id);
  assert.equal(results.length, 1, 'the next request must contain that status call result');
  // Provider projection concatenates the receipt and optional observation
  // text. Decode its complete JSON prefix without depending on that prose.
  const rendered = textOf(results[0]);
  let receipt;
  for (let end = rendered.indexOf('}'); end !== -1; end = rendered.indexOf('}', end + 1)) {
    try {
      const value = JSON.parse(rendered.slice(0, end + 1));
      if (value?.job_id === control.id) { receipt = value; break; }
    } catch { /* Nested object closings are not a complete JSON prefix. */ }
  }
  assert.ok(receipt, 'the paired status result must carry its JSON media receipt');
  return receipt;
}

test('a released image status can collect its original completed result in a later paired tool call', { timeout: 30000 }, async t => {
  const f = await fixture(t), control = await f.start('completed', 240, { collectAfterSteer: true });
  await assertFreshWait(control);
  await f.steer(control);
  const body = await control.nextModel.promise;
  const early = assertContinuation(body, control);
  assert.ok(['queued', 'running'].includes(early.status));
  assert.equal(early.wait_release_reason, 'steer');
  assertOneSubmissionAndNoCancel(f, control);
  control.state = 'completed'; control.release.resolve();
  const deadline = Date.now() + 3000;
  while ((await control.receipt()).status !== 'completed' && Date.now() < deadline) await delay(10);
  control.collectResult.resolve();
  assert.equal((await control.running).stopReason, 'end_turn');
  const status = assertContinuation(f.models.findLast(model => model.id === control.id).body, control, 1);
  assert.equal(status.status, 'completed');
  assert.equal(status.wait_release_reason, undefined, 'yield applies only to its original observer, not later calls');
  assert.equal(status.error, null);
  const saved = await control.receipt();
  assert.equal(saved.status, 'completed');
  assert.deepEqual(status.images.map(image => image.path), saved.images.map(image => image.path));
  assert.equal(saved.images.length, 1);
  assert.deepEqual(await readFile(saved.images[0].path), f.png);
  assertOneSubmissionAndNoCancel(f, control);
  assert.deepEqual(f.failures, []);
  t.diagnostic(JSON.stringify({ admissionMs: control.admittedAt - control.sentAt, nextModelMs: control.nextModelAt - control.sentAt }));
});

test('releasing an image foreground wait retains its original budget and the late failed receipt', { timeout: 30000 }, async t => {
  const f = await fixture(t), control = await f.start('foreground-deadline', 2);
  await assertFreshWait(control);
  await f.steer(control);
  const body = await control.nextModel.promise;
  assert.equal((await control.running).stopReason, 'end_turn');
  const status = assertContinuation(body, control);
  assert.ok(['queued', 'running'].includes(status.status));
  assert.equal(status.error, null);
  assert.notEqual(status.observation_error, true);
  assert.equal(status.waiting_in_background, false, 'one status deadline does not exhaust the 240-second job budget');
  assert.ok(Date.now() - Date.parse(status.created_at) < 240_000, 'the total foreground budget is still live');
  const saved = await control.receipt();
  assert.equal(saved.wait_release_reason, undefined, 'the per-call yield reason must not become persistent job state');
  assert.ok(['queued', 'running'].includes(saved.status), 'releasing the foreground caller must not finish or cancel its producer');
  assertOneSubmissionAndNoCancel(f, control);
  // A timed-out foreground refresh remains shared background work: settle it
  // explicitly before cleanup instead of deleting its receipt underneath it.
  control.state = 'failed'; control.release.resolve();
  const deadline = Date.now() + 3000;
  while ((await control.receipt()).status !== 'failed' && Date.now() < deadline) await delay(10);
  assert.equal((await control.receipt()).status, 'failed');
  assert.deepEqual(f.failures, []);
  t.diagnostic(JSON.stringify({ admissionMs: control.admittedAt - control.sentAt,
    nextModelMs: control.nextModelAt - control.sentAt, configuredForegroundWaitMs: control.statusWait * 1000 }));
});

for (const waitSeconds of [0, 240]) test(`steering releases a fresh ${waitSeconds}-second image status wait before its shared refresh returns`, { timeout: 15000 }, async t => {
  const f = await fixture(t), control = await f.start('early-release', waitSeconds);
  await assertFreshWait(control);
  await f.steer(control);
  const body = await Promise.race([control.nextModel.promise, delay(1500).then(() => null)]);
  assert.ok(body, 'new input must reach the model without waiting for remote history or the foreground deadline');
  const status = assertContinuation(body, control);
  assert.ok(['queued', 'running'].includes(status.status));
  assert.equal(status.waiting_in_background, false);
  assert.equal(status.error, null);
  assert.equal(control.blockedResponse.destroyed, false, 'steering must not abort the shared refresh');
  const shared = await f.jobs(control);
  assert.equal(shared.jobs.find(job => job.job_id === control.id).status, status.status);
  assert.equal(f.calls.filter(call => call.route === '/history/' + control.id).length, 1, 'sidebar joins the same in-flight refresh');
  assertOneSubmissionAndNoCancel(f, control);
  assert.equal((await control.running).stopReason, 'end_turn');

  // The waiter is gone; the original refresh must still publish its true
  // completed receipt and bytes without a second submission or model call.
  control.state = 'completed'; control.release.resolve();
  const deadline = Date.now() + 3000;
  while ((await control.receipt()).status !== 'completed' && Date.now() < deadline) await delay(10);
  const saved = await control.receipt();
  assert.equal(saved.status, 'completed', JSON.stringify({ saved, calls: f.calls, failures: f.failures.map(error => error.message) }));
  assert.deepEqual(await readFile(saved.images[0].path), f.png);
  assertOneSubmissionAndNoCancel(f, control);
  assert.deepEqual(f.failures, []);
  t.diagnostic(JSON.stringify({ nextModelMs: control.nextModelAt - control.sentAt, configuredWaitMs: waitSeconds * 1000 }));
});

test('steering retires the image observer while it sleeps between history checks', { timeout: 20000 }, async t => {
  const f = await fixture(t), control = await f.start('sleeping-observer', 240, { holdHistory: false });
  await assertFreshWait(control);
  // A running receipt is only saved after the first history/queue refresh.
  const deadline = Date.now() + 3000;
  while ((await control.receipt()).status !== 'running' && Date.now() < deadline) await delay(10);
  assert.equal((await control.receipt()).status, 'running');
  await f.steer(control);
  const body = await Promise.race([control.nextModel.promise, delay(1500).then(() => null)]);
  assert.ok(body, 'the cadence sleep must yield to admitted input');
  assert.equal(assertContinuation(body, control).wait_release_reason, 'steer');
  assert.equal((await control.running).stopReason, 'end_turn');
  const count = f.calls.filter(call => call.route === '/history/' + control.id).length;
  await delay(10_200);
  assert.equal(f.calls.filter(call => call.route === '/history/' + control.id).length, count,
    'a retired foreground observer must not start another history check after its original cadence');
  assertOneSubmissionAndNoCancel(f, control);
});

test('a shared history failure after steering remains an observation error instead of a generation failure', { timeout: 15000 }, async t => {
  const f = await fixture(t), control = await f.start('late-observation-error', 240);
  await assertFreshWait(control);
  await f.steer(control);
  assert.equal(assertContinuation(await control.nextModel.promise, control).wait_release_reason, 'steer');
  assert.equal((await control.running).stopReason, 'end_turn');
  control.state = 'observation_error'; control.release.resolve();
  let observed;
  const deadline = Date.now() + 3000;
  do {
    observed = (await f.jobs(control)).jobs.find(job => job.job_id === control.id);
    if (observed.observation_error) break;
    await delay(10);
  } while (Date.now() < deadline);
  assert.equal(observed.observation_error, true);
  assert.ok(['queued', 'running'].includes(observed.status));
  assert.equal(observed.error, null);
  assert.notEqual((await control.receipt()).status, 'failed');
  assertOneSubmissionAndNoCancel(f, control);
  assert.deepEqual(f.failures, []);
});

test('Compat Stop still cancels its original image job after a steering wait has yielded', { timeout: 20000 }, async t => {
  const f = await fixture(t), control = await f.start('stop-after-yield', 240, { collectAfterSteer: true });
  await assertFreshWait(control);
  await f.steer(control);
  assert.equal(assertContinuation(await control.nextModel.promise, control).wait_release_reason, 'steer');
  await f.stop(control);
  control.collectResult.resolve();
  assert.equal((await control.running).stopReason, 'cancelled');
  const saved = await control.receipt();
  assert.equal(saved.status, 'cancelled');
  assert.equal(saved.cancel_requested, true);
  assert.equal(f.calls.filter(call => call.route === '/prompt').length, 1);
  assert.deepEqual(f.calls.filter(call => call.route.includes('/cancel')).map(call => call.id), [control.id]);
  assert.deepEqual(f.failures, []);
});

test('Compat Stop cancels only its conversation image job and reconciles the authoritative interrupted receipt', { timeout: 30000 }, async t => {
  const f = await fixture(t), other = await f.start('other-conversation', null);
  assert.equal((await other.running).stopReason, 'end_turn');
  const control = await f.start('stop-current');
  await assertFreshWait(control);
  await f.stop(control);
  assert.equal((await control.running).stopReason, 'cancelled');
  const cancelled = await control.receipt(), unaffected = await other.receipt();
  assert.equal(cancelled.cancel_requested, true);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(unaffected.status, 'queued');
  assert.notEqual(unaffected.cancel_requested, true);
  assert.deepEqual(f.calls.filter(call => call.route.includes('/cancel')).map(call => call.id), [control.id]);
  assert.equal(f.calls.filter(call => call.route === '/prompt').length, 2);
  assert.equal(f.calls.some(call => call.route === '/interrupt'), false);
  assert.deepEqual(f.failures, []);
});
