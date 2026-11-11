import { replyToNoActionReview } from '../harness/test/review-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHarnessDriver } from '../harness/index.mjs';

test('official user-question tool waits for host input, returns the real answer and supports cancellation', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codebuddy-questions-'));
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    if (replyToNoActionReview(body, res)) return;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'ask-fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (body.messages.some(m => m.role === 'tool')) {
      emit({ role: 'assistant', content: 'Answer received.' }); emit({}, 'stop');
    } else {
      emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'question-call', type: 'function', function: { name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'color', question: 'Which color?', options: [{ label: 'Mint' }, { label: 'Cream' }] }] }) } }] });
      emit({}, 'tool_calls');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const driver = await createHarnessDriver({ dataDir: root, cwd: root });
  t.after(async () => { await driver.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const provider = { id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture' };
  const { sessionId } = await driver.createSession({ cwd: root, provider, model: 'fixture' });
  const asked = Promise.withResolvers(), answer = Promise.withResolvers();
  const events = [];
  const pending = driver.prompt(sessionId, 'Ask me to choose a color.', {
    onPermission: () => true, onEvent: e => events.push(e),
    onUserQuestions: request => { asked.resolve(request); return answer.promise; },
  });
  const request = await asked.promise;
  assert.equal(request.questions[0].question, 'Which color?');
  assert.ok(!events.some(e => e.type === 'tool_result' && e.name === 'ask_user_question'));
  answer.resolve({ answers: [{ id: 'color', selected: ['Mint'] }] });
  await pending;
  assert.ok(events.some(e => e.type === 'tool_result' && JSON.stringify(e).includes('Mint')));
  const other = await driver.createSession({ cwd: root, provider, model: 'fixture' });
  const controller = new AbortController(), reached = Promise.withResolvers();
  const cancelled = driver.prompt(other.sessionId, 'Ask again.', { signal: controller.signal, onPermission: () => true,
    onUserQuestions: request => { reached.resolve(); return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })); },
  });
  await reached.promise; controller.abort();
  await cancelled.catch(error => assert.match(String(error), /abort|cancel/i));
});

test('native timed questions allow one late reply only during the running turn; stop and cold restore do not reopen old cards', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codebuddy-timed-questions-'));
  let gate = Promise.withResolvers(), toolSeen = Promise.withResolvers();
  let timeout = 1;
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    if (replyToNoActionReview(body, res)) return; requests.push(body);
    const tool = body.messages.find(m => m.role === 'tool');
    if (tool) { toolSeen.resolve(tool); await gate.promise; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'timed-fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (tool) { emit({ role: 'assistant', content: 'Finished the independent work.' }); emit({}, 'stop'); }
    else {
      emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'timed-call', type: 'function', function: { name: 'ask_user_question', arguments: JSON.stringify({ timeout, questions: [{ id: 'color', question: 'Which color?', options: [{ label: 'Mint' }, { label: 'Cream' }] }] }) } }] });
      emit({}, 'tool_calls');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let driver = await createHarnessDriver({ dataDir: root, cwd: root });
  t.after(async () => { gate.resolve(); await driver.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const provider = { id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture' };
  const session = await driver.createSession({ cwd: root, provider, model: 'fixture' });
  const asked = Promise.withResolvers();
  const events = [];
  const wait = request => {
    asked.resolve(request);
    return new Promise((_resolve, reject) => {
      if (request.signal.aborted) reject(request.signal.reason);
      else request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
    });
  };
  const pending = driver.prompt(session.sessionId, 'Ask a noncritical preference, then work.', { onPermission: () => true, onUserQuestions: wait, onEvent: e => events.push(e) });
  const question = await asked.promise;
  assert.equal(question.wait.timed, true);
  assert.ok(question.wait.remainingMs > 0 && question.wait.remainingMs <= 1000);
  const tool = await toolSeen.promise;
  assert.equal(JSON.parse(tool.content).pending, true, 'Timeout is a native pending result, not an error or a skipped answer');
  const snapshot = await driver.questions(session.sessionId);
  assert.equal(snapshot.active[0].state, 'continued');
  const callId = snapshot.active[0].callId;
  assert.equal(await driver.answerQuestion(session.sessionId, callId, { answers: [{ id: 'color', selected: ['Mint'] }] }), true);
  await assert.rejects(driver.answerQuestion(session.sessionId, callId, { answers: [{ id: 'color', selected: ['Cream'] }] }), /queued/);
  gate.resolve(); await pending;
  const history = await driver.history(session.sessionId);
  assert.ok(history.events.some(e => e.type === 'user/message' && e.data.source.kind === 'user-question-reply'));
  assert.equal((await driver.questions(session.sessionId)).active.length, 0);
  await assert.rejects(driver.answerQuestion(session.sessionId, callId, { answers: [] }), /停止/);

  // End a turn without replying: the native record stays truthful, but the
  // product's reply window closes and must not start another model request.
  gate = Promise.withResolvers(); toolSeen = Promise.withResolvers();
  const completed = await driver.createSession({ cwd: root, provider, model: 'fixture' });
  const finish = driver.prompt(completed.sessionId, 'Ask, then finish.', { onPermission: () => true, onUserQuestions: wait });
  await toolSeen.promise; gate.resolve(); await finish;
  assert.equal((await driver.questions(completed.sessionId)).active.length, 0);

  gate = Promise.withResolvers(); toolSeen = Promise.withResolvers();
  const stopped = await driver.createSession({ cwd: root, provider, model: 'fixture' });
  const controller = new AbortController();
  const stopping = driver.prompt(stopped.sessionId, 'Ask, then keep working.', { signal: controller.signal, onPermission: () => true, onUserQuestions: wait });
  await toolSeen.promise; controller.abort(); gate.resolve(); await stopping;
  assert.equal((await driver.questions(stopped.sessionId)).active.length, 0);
  await driver.close(); driver = await createHarnessDriver({ dataDir: root, cwd: root });
  await driver.createSession({ ...stopped, cwd: root, provider, model: 'fixture' });
  assert.equal((await driver.questions(stopped.sessionId)).active.length, 0, 'Restart must not restore an actionable card for an ended turn');
  const resumed = await driver.prompt(stopped.sessionId, 'Continue the unfinished work.', { onPermission: () => true });
  assert.equal(resumed.stopReason, 'end_turn');

  // A required decision uses the official infinite wait and remains cancellable.
  timeout = -1;
  const required = await driver.createSession({ cwd: root, provider, model: 'fixture' });
  const requiredAsked = Promise.withResolvers(), requiredAbort = new AbortController();
  const requiredRun = driver.prompt(required.sessionId, 'Wait for a critical decision.', { signal: requiredAbort.signal,
    onPermission: () => true, onUserQuestions: request => { requiredAsked.resolve(request); return wait(request); } });
  const requiredRequest = await requiredAsked.promise;
  assert.equal(requiredRequest.wait.remainingMs, undefined);
  assert.equal(requiredRequest.wait.timed, undefined);
  requiredAbort.abort(); await requiredRun;
});
