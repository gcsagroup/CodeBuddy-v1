import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, access, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHarnessDriver } from '../index.mjs';
import { replyToNoActionReview } from './review-fixture.mjs';
import { Compat } from '../../compat.mjs';
import { openStore } from '../../store.mjs';
import { DesktopCoordinator } from '../../desktop-coordinator.mjs';

const CodeBuddyPwshExecutor = process.platform === 'win32' ? (await import('../pwsh-executor.mjs')).default : undefined;
const { SandboxUnavailableError } = await import('@deepseek-ai/dsh-sandbox');

async function fixture(t, { responses = false, initialPermissionPreset } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-steering-'));
  const requests = [], started = Promise.withResolvers();
  const controls = { firstTool: null };
  let held;
  const finish = res => {
    if (responses) {
      res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'response-fixture', status: 'completed', output: [], usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } }) + '\n\n');
      return;
    }
    res.write('data: ' + JSON.stringify({ id: 'steering', model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  };
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      if (req.url.endsWith('/models')) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'fixture' }] }));
      else res.writeHead(404).end();
      return;
    }
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    if (replyToNoActionReview(body, res)) return;
    requests.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests.length === 1 && controls.firstTool) {
      res.write('data: ' + JSON.stringify({ id: 'steering', model: 'fixture', choices: [{ index: 0, delta: {
        tool_calls: [{ index: 0, id: 'original-call', type: 'function', function: controls.firstTool }],
      }, finish_reason: null }] }) + '\n\n');
      finish(res); started.resolve(); return;
    }
    const text = requests.length === 1 ? 'VISIBLE_UNFINISHED_PREFIX' : 'AFTER_STEER';
    if (responses) {
      const emit = event => res.write('data: ' + JSON.stringify(event) + '\n\n');
      emit({ type: 'response.created', response: { id: 'response-fixture' } });
      if (requests.length === 1) emit({ type: 'response.output_item.done', output_index: 0,
        item: { type: 'message', id: 'closed', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'COMPLETED_ITEM', annotations: [] }] } });
      emit({ type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'open', role: 'assistant', status: 'in_progress', content: [] } });
      emit({ type: 'response.output_text.delta', output_index: 1, content_index: 0, item_id: 'open', delta: text });
      if (requests.length !== 1) emit({ type: 'response.output_item.done', output_index: 1,
        item: { type: 'message', id: 'open', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] } });
    } else res.write('data: ' + JSON.stringify({ id: 'steering', model: 'fixture', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) + '\n\n');
    if (requests.length === 1 || controls.holdFollowing) { held = res; started.resolve(); }
    else { finish(res); controls.onFollowingFinish?.(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd: root });
  const provider = { id: 'fixture', protocol: responses ? 'openai-responses' : 'openai-completions', apiKey: 'fixture-only', baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
  const { sessionId } = await driver.createSession({ cwd: root, provider, model: 'fixture', options: { autoCompactThreshold: 0.99, initialPermissionPreset } });
  t.after(async () => {
    held?.destroy();
    await driver.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { driver, sessionId, requests, root, provider, controls, started: started.promise, finish: () => finish(held) };
}

test('steer preempts only the model request and continues the same native turn without replaying its unfinished item', { timeout: 15000 }, async t => {
  const f = await fixture(t), events = [], visible = Promise.withResolvers();
  const running = f.driver.prompt(f.sessionId, 'INITIAL_USER', { requestId: 'initial', onEvent: e => {
    events.push(e); if (e.type === 'text_delta' && e.text.includes('VISIBLE_UNFINISHED_PREFIX')) visible.resolve();
  } });
  await visible.promise;
  await f.driver.steer(f.sessionId, 'STEER_USER', { requestId: 'steer', preempt: true });
  assert.equal((await running).stopReason, 'end_turn');
  assert.equal(f.requests.length, 2);
  const input = JSON.stringify(f.requests[1].messages);
  assert.match(input, /INITIAL_USER/);
  assert.match(input, /STEER_USER/);
  assert.doesNotMatch(input, /VISIBLE_UNFINISHED_PREFIX/);
  const { events: log } = await f.driver.history(f.sessionId);
  assert.equal(log.filter(e => e.type === 'turn/start').length, 1);
  assert.equal(log.filter(e => e.type === 'user/message' && e.data.source?.rpcId === 'steer').length, 1);
  assert.equal(log.filter(e => e.type === 'assistant/message' && JSON.stringify(e.data.message).includes('VISIBLE_UNFINISHED_PREFIX')).length, 0);
  assert.equal(log.some(e => e.type === 'assistant/attempt'), true);
  assert.equal(log.some(e => e.type === 'turn/end' && e.data.reason.kind === 'aborted'), false);
  assert.equal(events.some(e => e.type === 'text_delta' && e.text.includes('VISIBLE_UNFINISHED_PREFIX')), true);
});

test('steering completion waits for delayed persistence without starving I/O', { timeout: 20000 }, async () => {
  // The parent timeout must remain outside the potentially starved event loop.
  const env = { ...process.env, CODEBUDDY_STEERING_FLUSH_CHILD: '1' };
  delete env.NODE_TEST_CONTEXT;
  const { stdout } = await promisify(execFile)(process.execPath, ['--test-name-pattern=^slow steering flush child$', fileURLToPath(import.meta.url)], {
    env, timeout: 15000, windowsHide: true,
  });
  assert.match(stdout, /STEERING_FLUSH_CONFIRMED/);
});

for (const preempt of [false, true]) test(`steering owns slow input preparation across natural completion: preempt=${preempt}`, { timeout: 15000 }, async t => {
  const f = await fixture(t), visible = Promise.withResolvers(), ended = Promise.withResolvers();
  const prepared = Promise.withResolvers();
  let preparing = false, settled = false;
  const running = f.driver.prompt(f.sessionId, 'INITIAL_USER', { onEvent: event => {
    if (event.type === 'text_delta') visible.resolve();
    if (event.type === 'harness_event' && event.event.type === 'turn/end') ended.resolve();
  } });
  running.then(() => { settled = true; }, () => { settled = true; });
  t.after(() => prepared.resolve());
  await visible.promise;
  const steering = f.driver.steer(f.sessionId, 'ATTACHMENT_QUERY', { requestId: 'prepared-input', preempt,
    prepareContent: async content => {
      preparing = true;
      await prepared.promise;
      return [{ type: 'text', text: content + ': OBSERVED_IMAGE_CONTENT' }];
    },
  });
  steering.catch(() => {});
  assert.equal(preparing, true, 'preparation must start inside the owned steering operation');
  f.finish();
  await ended.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'the original ACP owner must remain alive while an accepted input is preparing');
  prepared.resolve();
  assert.equal((await running).stopReason, 'end_turn');
  await steering;
  assert.equal(f.requests.length, 2);
  assert.match(JSON.stringify(f.requests[1].messages), /ATTACHMENT_QUERY: OBSERVED_IMAGE_CONTENT/);
  const { events } = await f.driver.history(f.sessionId);
  assert.equal(events.filter(event => event.type === 'user/message' && event.data.source?.rpcId === 'prepared-input').length, 1);
  assert.equal(events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'aborted'), false);
});

for (const outcome of ['stop', 'prepare-error']) test(`steering preparation cannot admit input after ${outcome}`, { timeout: 15000 }, async t => {
  const f = await fixture(t), visible = Promise.withResolvers(), prepared = Promise.withResolvers();
  let preparing = false;
  const running = f.driver.prompt(f.sessionId, 'INITIAL_USER', { onEvent: event => {
    if (event.type === 'text_delta') visible.resolve();
  } });
  t.after(() => prepared.resolve());
  await visible.promise;
  const failure = new Error('IMAGE_PREPARATION_FAILED');
  const steering = f.driver.steer(f.sessionId, 'MUST_NOT_BE_ADMITTED', { requestId: 'unprepared', preempt: true,
    prepareContent: async () => {
      preparing = true;
      await prepared.promise;
      if (outcome === 'prepare-error') throw failure;
      return [{ type: 'text', text: 'MUST_NOT_BE_ADMITTED' }];
    },
  });
  steering.catch(() => {});
  assert.equal(preparing, true);
  const rejected = assert.rejects(steering, outcome === 'prepare-error' ? failure : { harnessCode: 'PROMPT_IDLE' });
  if (outcome === 'stop') await f.driver.cancel(f.sessionId);
  prepared.resolve();
  await rejected;
  if (outcome === 'prepare-error') f.finish();
  assert.equal((await running).stopReason, outcome === 'stop' ? 'cancelled' : 'end_turn');
  assert.equal(f.requests.length, 1);
  const { events } = await f.driver.history(f.sessionId);
  assert.equal(events.filter(event => event.type === 'user/message' && event.data.source?.rpcId === 'unprepared').length, 0);
});

for (const preempt of [false, true]) test(`Compat reserves steering before asynchronous image preparation: preempt=${preempt}`, { timeout: 15000 }, async t => {
  const f = await fixture(t), visible = Promise.withResolvers(), ended = Promise.withResolvers();
  const preparing = Promise.withResolvers(), prepared = Promise.withResolvers();
  const store = await openStore(join(f.root, 'host'));
  await store.update(state => {
    state.providers = [{ id: 'fixture', engine: 'openai_compatible', apiUrl: f.provider.baseUrl,
      models: ['fixture'], requiresAuth: false }];
    state.defaults = { providerId: 'fixture', modelId: 'fixture' };
    state.preferences.gooseMode = 'auto';
  });
  const prompt = f.driver.prompt.bind(f.driver);
  t.mock.method(f.driver, 'prompt', (id, content, options) => prompt(id, content, { ...options, onEvent: async event => {
    if (event.type === 'text_delta') visible.resolve();
    if (event.type === 'harness_event' && event.event.type === 'turn/end') ended.resolve();
    await options.onEvent?.(event);
  } }));
  const host = new Compat(store, f.driver);
  host.desktop = new DesktopCoordinator({ directory: join(f.root, 'desktop-control') });
  await host.initialize();
  t.after(async () => { prepared.resolve(); await host.close(); });
  const connection = { sessionIds: new Set(), notify() {} };
  const { sessionId } = await host.request('session/new', { cwd: f.root, mcpServers: [] }, connection);
  const prepare = host.prepareModelContent.bind(host);
  t.mock.method(host, 'prepareModelContent', async (session, content, ...rest) => {
    if (!content.some(part => part.type === 'image')) return prepare(session, content, ...rest);
    preparing.resolve();
    await prepared.promise;
    return { content: [{ type: 'text', text: 'QUERY_WITH_PREPARED_IMAGE' }], observations: [] };
  });
  let settled = false;
  const running = host.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'INITIAL_USER' }] }, connection);
  running.then(() => { settled = true; }, () => { settled = true; });
  await visible.promise;
  const active = host.active.get(sessionId);
  const steering = host.request('_goose/unstable/session/steer', { sessionId,
    expectedRunId: active.run?.runId ?? active.desktopControlToken,
    prompt: [{ type: 'text', text: 'QUERY' }, { type: 'image', mimeType: 'image/png', data: 'cGl4ZWxz' }],
    _meta: { 'codeagentpro/source-message-id': 'image-input', ...(preempt ? { 'codebuddy/input-mode': 'steer' } : {}) },
  }, connection);
  steering.catch(() => {});
  await preparing.promise;
  f.finish();
  await ended.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'Compat must not prepare first and reserve the native owner only afterwards');
  prepared.resolve();
  await steering;
  assert.equal((await running).stopReason, 'end_turn');
  assert.equal(f.requests.length, 2);
  assert.match(JSON.stringify(f.requests[1].messages), /QUERY_WITH_PREPARED_IMAGE/);
  const { events } = await f.driver.history(sessionId);
  assert.equal(events.filter(event => event.type === 'user/message' && event.data.source?.rpcId === 'image-input').length, 1);
});

test('slow steering flush child', { skip: process.env.CODEBUDDY_STEERING_FLUSH_CHILD !== '1' }, async t => {
  const f = await fixture(t), visible = Promise.withResolvers(), persisted = Promise.withResolvers();
  const running = f.driver.prompt(f.sessionId, 'INITIAL_USER', { onEvent: event => {
    if (event.type === 'text_delta') visible.resolve();
  } });
  await visible.promise;
  const { SessionStore } = await import('@deepseek-ai/dsh-session');
  const original = SessionStore.prototype.flush;
  let timerRan = false;
  f.controls.onFollowingFinish = () => setTimeout(() => { timerRan = true; persisted.resolve(); }, 50);
  t.mock.method(SessionStore.prototype, 'flush', async function(session) {
    if (session.id === f.sessionId) await persisted.promise;
    return original.call(this, session);
  });
  const steering = f.driver.steer(f.sessionId, 'STEER_USER', { requestId: 'slow-flush', preempt: true });
  const [result] = await Promise.all([running, steering]);
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(timerRan, true);
  assert.equal(f.requests.length, 2);
  console.log('STEERING_FLUSH_CONFIRMED');
});

test('preemption retains a completed Responses item while dropping the following open item', { timeout: 15000 }, async t => {
  const f = await fixture(t, { responses: true }), visible = Promise.withResolvers();
  const running = f.driver.prompt(f.sessionId, 'INITIAL_USER', { onEvent: e => {
    if (e.type === 'text_delta') visible.resolve();
  } });
  await visible.promise;
  await f.driver.steer(f.sessionId, 'STEER_USER', { requestId: 'mixed-steer', preempt: true });
  await running;
  const { events } = await f.driver.history(f.sessionId);
  const content = events.filter(e => e.type === 'assistant/message').flatMap(e => e.data.message.content);
  assert.ok(content.some(block => block.type === 'text' && block.text === 'COMPLETED_ITEM'));
  assert.ok(!content.some(block => block.type === 'text' && block.text.includes('VISIBLE_UNFINISHED_PREFIX')));
  assert.match(JSON.stringify(f.requests[1].input), /COMPLETED_ITEM/);
  assert.doesNotMatch(JSON.stringify(f.requests[1].input), /VISIBLE_UNFINISHED_PREFIX/);
});

test('legacy steer still waits for natural request completion and retains that completed reply', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const running = f.driver.prompt(f.sessionId, 'INITIAL_USER');
  await f.started;
  await f.driver.steer(f.sessionId, 'STEER_USER', { requestId: 'legacy-steer' });
  assert.equal(f.requests.length, 1);
  f.finish();
  assert.equal((await running).stopReason, 'end_turn');
  assert.equal(f.requests.length, 2);
  assert.match(JSON.stringify(f.requests[1].messages), /VISIBLE_UNFINISHED_PREFIX/);
});

test('steering does not answer an approval and prevents an obsolete write after approval settles', { timeout: 15000 }, async t => {
  const f = await fixture(t), asked = Promise.withResolvers(), answer = Promise.withResolvers();
  const file = join(f.root, 'obsolete.txt');
  f.controls.firstTool = { name: 'write', arguments: JSON.stringify({ file_path: file, content: 'obsolete' }) };
  const running = f.driver.prompt(f.sessionId, 'INITIAL_USER', {
    onToolPolicy: () => ({ kind: 'ask' }), onPermission: async () => { asked.resolve(); return answer.promise; },
  });
  await asked.promise;
  await f.driver.steer(f.sessionId, 'STEER_USER', { requestId: 'approval-steer', preempt: true });
  assert.equal(f.requests.length, 1);
  answer.resolve(true);
  await running;
  await assert.rejects(access(file));
  assert.equal(f.requests.length, 2);
  assert.match(JSON.stringify(f.requests[1].messages), /STEER_USER/);
  const { events } = await f.driver.history(f.sessionId);
  assert.ok(events.some(e => e.type === 'tool/result' && e.data.message.isError));
});

test('steering yields job_output without killing the producer or losing its terminal result', { timeout: 30000 }, async t => {
  const f = await fixture(t), waiting = Promise.withResolvers();
  const shell = process.platform === 'win32' ? 'pwsh' : 'bash';
  const command = process.platform === 'win32'
    ? "Start-Sleep -Seconds 3; Write-Output 'STEERING_JOB_RESULT'" : "sleep 3; printf 'STEERING_JOB_RESULT'";
  const options = { onPermission: async () => true };
  const launched = await f.driver.callTool(f.sessionId, shell, { description: 'Isolated steering job fixture', command, run_in_background: true }, options);
  assert.equal(launched.isError, false, JSON.stringify(launched));
  const id = launched.value.jobId;
  f.controls.firstTool = { name: 'job_output', arguments: JSON.stringify({ job_id: id, wait: true, timeout_ms: 15000 }) };
  const running = f.driver.prompt(f.sessionId, 'INITIAL_USER', {
    ...options, onToolStart: call => { if (call.name === 'job_output') waiting.resolve(); },
  });
  await waiting.promise;
  await f.driver.steer(f.sessionId, 'STEER_USER', { requestId: 'job-steer', preempt: true });
  await running;
  const waitResult = f.requests[1].messages.find(message => message.role === 'tool' && message.tool_call_id === 'original-call');
  assert.match(JSON.stringify(waitResult), /running/);
  const result = await f.driver.callTool(f.sessionId, 'job_output', { job_id: id, wait: true, timeout_ms: 15000 }, options);
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.match(JSON.stringify(result.content), /STEERING_JOB_RESULT/);
  assert.doesNotMatch(JSON.stringify(result.content), /status: killed/);
});

for (const outcome of ['complete', 'stop']) test(`steering releases an already writing foreground command, then ${outcome}`, {
  skip: process.platform !== 'win32', timeout: 20000,
}, async t => {
  const f = await fixture(t, { initialPermissionPreset: 'danger-full-access' });
  const file = join(f.root, 'foreground.log');
  f.controls.firstTool = { name: 'pwsh', arguments: JSON.stringify({
    description: 'Isolated foreground write fixture', timeoutMs: 15000,
    command: "1..10 | ForEach-Object { Add-Content -LiteralPath 'foreground.log' -Value $_; Start-Sleep -Milliseconds 250 }; Write-Output 'FOREGROUND_DONE'",
  }) };
  const published = [];
  f.controls.holdFollowing = outcome === 'stop';
  const running = f.driver.prompt(f.sessionId, 'INITIAL_USER', { onEvent: event => published.push(event) });
  running.catch(() => {});
  const deadline = Date.now() + 10000;
  while (!await readFile(file, 'utf8').catch(() => '') && Date.now() < deadline) await delay(20);
  assert.ok(await readFile(file, 'utf8'), 'the actual producer must have started before steering');
  await f.driver.steer(f.sessionId, 'STEER_USER', { requestId: 'foreground-steer', preempt: true });
  const consumed = Date.now() + 1000;
  while (f.requests.length < 2 && Date.now() < consumed) await delay(10);
  assert.equal(f.requests.length, 2, 'input must reach the model before the foreground command finishes');
  assert.match(JSON.stringify(f.requests[1].messages), /STEER_USER/);
  assert.ok((await readFile(file, 'utf8')).trim().split(/\r?\n/).length < 10, 'the original producer must still be writing');
  const receipt = published.find(event => event.type === 'tool_result' && event.id === 'original-call');
  assert.equal(receipt.structuredContent.kind, 'promoted');
  assert.equal(receipt.structuredContent.releaseReason, 'steer');
  assert.equal(receipt.structuredContent.preparing, false);
  assert.doesNotMatch(JSON.stringify(receipt.result), /still running after 15000ms/);
  if (outcome === 'stop') await f.driver.cancel(f.sessionId);
  assert.equal((await running).stopReason, outcome === 'stop' ? 'cancelled' : 'end_turn');
  const result = await f.driver.callTool(f.sessionId, 'job_output', { job_id: receipt.structuredContent.jobId, wait: true, timeout_ms: 10000 });
  assert.equal(result.isError, false, JSON.stringify(result));
  const lines = (await readFile(file, 'utf8')).trim().split(/\r?\n/).map(Number);
  assert.deepEqual(lines, Array.from({ length: lines.length }, (_, i) => i + 1));
  if (outcome === 'complete') {
    assert.match(JSON.stringify(result.content), /FOREGROUND_DONE/);
    assert.match(JSON.stringify(result.content), /exit code: 0/);
    assert.equal(lines.length, 10);
  } else {
    assert.equal(result.value.job.status, 'killed');
    assert.ok(lines.length >= 1 && lines.length < 10);
    const stopped = await readFile(file, 'utf8');
    await delay(500);
    assert.equal(await readFile(file, 'utf8'), stopped);
  }
  const { events } = await f.driver.history(f.sessionId);
  assert.equal(events.filter(event => event.type === 'user/message' && event.data.source?.rpcId === 'foreground-steer').length, 1);
});

for (const outcome of ['complete', 'fail', 'stop']) test(`foreground preparation can yield to input and then ${outcome}`, {
  skip: process.platform !== 'win32', timeout: 20000,
}, async t => {
  const entered = Promise.withResolvers(), proceed = Promise.withResolvers();
  proceed.promise.catch(() => {});
  const command = "Set-Content -LiteralPath 'prepared.log' -Value 'once'; Write-Output 'PREPARED_DONE'";
  const execute = CodeBuddyPwshExecutor.prototype.execute;
  let starts = 0, producerSignal;
  t.mock.method(CodeBuddyPwshExecutor.prototype, 'execute', async function(spec) {
    if (spec.command !== command) return execute.call(this, spec);
    starts++;
    producerSignal = spec.signal;
    const abort = () => proceed.reject(spec.signal.reason);
    spec.signal.addEventListener('abort', abort, { once: true });
    entered.resolve();
    try { await proceed.promise; spec.signal.throwIfAborted(); }
    finally { spec.signal.removeEventListener('abort', abort); }
    if (outcome === 'fail') throw new SandboxUnavailableError('workspace-write', 'PREPARATION_FAILED_FIXTURE');
    return execute.call(this, spec);
  });
  t.after(() => proceed.resolve());
  const f = await fixture(t, { initialPermissionPreset: 'danger-full-access' });
  const published = [];
  f.controls.holdFollowing = outcome !== 'fail';
  f.controls.firstTool = { name: 'pwsh', arguments: JSON.stringify({ description: 'Isolated preparation fixture', command, timeoutMs: 15000 }) };
  const running = f.driver.prompt(f.sessionId, 'INITIAL_USER', { onEvent: event => published.push(event) });
  running.catch(() => {});
  await entered.promise;
  await f.driver.steer(f.sessionId, 'FIRST_INPUT', { requestId: 'preparing-first', preempt: true });
  const deadline = Date.now() + 1000;
  while (f.requests.length < 2 && Date.now() < deadline) await delay(10);
  assert.equal(f.requests.length, 2);
  assert.match(JSON.stringify(f.requests[1].messages), /FIRST_INPUT/);
  assert.equal(producerSignal.aborted, false);
  await assert.rejects(access(join(f.root, 'prepared.log')));
  const receipt = published.find(event => event.type === 'tool_result' && event.id === 'original-call');
  assert.equal(receipt.structuredContent.preparing, true);
  assert.equal(receipt.structuredContent.releaseReason, 'steer');
  assert.match(JSON.stringify(receipt.result), /command start not yet confirmed/);
  const id = receipt.structuredContent.jobId;
  if (outcome === 'stop') {
    await f.driver.cancel(f.sessionId);
    assert.equal((await running).stopReason, 'cancelled');
    assert.equal(producerSignal.aborted, true);
    const result = await f.driver.callTool(f.sessionId, 'job_output', { job_id: id });
    assert.equal(result.value.job.status, 'killed');
    await assert.rejects(access(join(f.root, 'prepared.log')));
  } else {
    if (outcome === 'complete') {
      await f.driver.steer(f.sessionId, 'SECOND_INPUT', { requestId: 'preparing-second', preempt: true });
      const next = Date.now() + 1000;
      while (f.requests.length < 3 && Date.now() < next) await delay(10);
      assert.equal(f.requests.length, 3);
      assert.match(JSON.stringify(f.requests[2].messages), /FIRST_INPUT/);
      assert.match(JSON.stringify(f.requests[2].messages), /SECOND_INPUT/);
      f.finish();
    }
    await running;
    proceed.resolve();
    const result = await f.driver.callTool(f.sessionId, 'job_output', { job_id: id, wait: true, timeout_ms: 10000 });
    assert.equal(result.isError, false);
    assert.equal(result.value.job.status, outcome === 'complete' ? 'completed' : 'failed');
    if (outcome === 'complete') {
      assert.equal((await readFile(join(f.root, 'prepared.log'), 'utf8')).trim(), 'once');
      assert.match(JSON.stringify(result.content), /PREPARED_DONE/);
    } else {
      assert.match(JSON.stringify(result.content), /PREPARATION_FAILED_FIXTURE/);
      await assert.rejects(access(join(f.root, 'prepared.log')));
    }
  }
  assert.equal(starts, 1);
  const { events } = await f.driver.history(f.sessionId);
  assert.equal(events.filter(event => event.type === 'user/message' && event.data.source?.rpcId === 'preparing-first').length, 1);
  assert.equal(events.filter(event => event.type === 'turn/start').length, 1);
});

test('preparation timeout without steering keeps the original cancellation and receipt', {
  skip: process.platform !== 'win32', timeout: 15000,
}, async t => {
  const command = "Set-Content -LiteralPath 'must-not-run.log' -Value 'bad'";
  const execute = CodeBuddyPwshExecutor.prototype.execute;
  let cancelled = false;
  t.mock.method(CodeBuddyPwshExecutor.prototype, 'execute', async function(spec) {
    if (spec.command !== command) return execute.call(this, spec);
    await new Promise((resolve, reject) => {
      const abort = () => { cancelled = true; reject(spec.signal.reason); };
      if (spec.signal.aborted) abort();
      else spec.signal.addEventListener('abort', abort, { once: true });
    });
    return execute.call(this, spec);
  });
  const f = await fixture(t, { initialPermissionPreset: 'danger-full-access' });
  const result = await f.driver.callTool(f.sessionId, 'pwsh', { description: 'Isolated timeout fixture', command, timeoutMs: 100 });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.value.kind, 'foreground');
  assert.equal(result.value.timedOut, true);
  assert.match(JSON.stringify(result.content), /user command was not started/);
  assert.equal(cancelled, true);
  await assert.rejects(access(join(f.root, 'must-not-run.log')));
});
