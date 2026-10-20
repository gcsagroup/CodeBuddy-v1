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
