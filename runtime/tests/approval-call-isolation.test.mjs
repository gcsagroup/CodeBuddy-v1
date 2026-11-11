import { replyToNoActionReview } from '../harness/test/review-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHarnessDriver } from '../harness/index.mjs';

test('concurrent chats keep approval arguments and cleanup separate when model call ids match', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codebuddy-approval-call-isolation-'));
  const callId = 'shared-provider-call-id';
  const ids = { A: randomUUID(), B: randomUUID() };
  const readyA = Promise.withResolvers(), readyB = Promise.withResolvers();
  const releaseA = Promise.withResolvers(), releaseB = Promise.withResolvers();
  const permissions = [], starts = [], effects = [], failures = [];
  const model = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const part of req) raw += part;
      const body = JSON.parse(raw);
    if (replyToNoActionReview(body, res)) return;
      const input = body.messages.findLastIndex(message => message.role === 'user' && /APPROVAL_CHAT_[AB]/.test(JSON.stringify(message.content)));
      const chat = JSON.stringify(body.messages[input]?.content).includes('APPROVAL_CHAT_A') ? 'A' : 'B';
      const replied = body.messages.slice(input + 1).some(message => message.role === 'tool');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({
        id: randomUUID(), object: 'chat.completion.chunk', model: body.model,
        choices: [{ index: 0, delta, finish_reason }],
      }) + '\n\n');
      if (!replied) {
        emit({ role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: {
          name: 'fixture_action', arguments: JSON.stringify({ chat }),
        } }] });
        emit({}, 'tool_calls');
      } else {
        emit({ role: 'assistant', content: 'DONE' });
        emit({}, 'stop');
      }
      res.end('data: [DONE]\n\n');
    } catch (error) { failures.push(error); res.destroy(error); }
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const driver = await createHarnessDriver({ dataDir: join(directory, 'native'), cwd: directory });
  t.after(async () => {
    releaseA.resolve(); releaseB.resolve();
    await driver.close();
    model.closeAllConnections();
    await new Promise(resolve => model.close(resolve));
  });
  const provider = {
    id: 'approval-isolation-fixture', baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
    apiKey: 'fixture-only', protocol: 'openai-completions',
  };
  for (const [chat, sessionId] of Object.entries(ids)) {
    await driver.createSession({ sessionId, cwd: directory, provider, model: 'fixture-model', options: { tools: [{
      name: 'fixture_action',
      inputSchema: { type: 'object', properties: { chat: { type: 'string' } }, required: ['chat'] },
      async execute(args) { effects.push({ chat, args }); return { done: true }; },
    }] } });
  }
  const callbacks = chat => ({
    async onToolPolicy(call) {
      if (call.name !== 'fixture_action') return { kind: 'allow' };
      if (chat === 'A') { readyA.resolve(); await releaseA.promise; }
      else { readyB.resolve(); await releaseB.promise; }
      return { kind: 'ask', reason: 'The isolated action needs an answer from this chat.' };
    },
    async onPermission(call) {
      permissions.push({ chat, sessionId: call.sessionId, callId: call.id, args: call.arguments });
      return chat === 'A' && call.sessionId === ids.A && call.arguments.chat === 'A';
    },
    onToolStart(call) { starts.push({ chat, sessionId: call.sessionId, callId: call.id, args: call.arguments }); },
  });
  const a = driver.prompt(ids.A, 'APPROVAL_CHAT_A', callbacks('A'));
  a.catch(() => {});
  await readyA.promise;
  const b = driver.prompt(ids.B, 'APPROVAL_CHAT_B', callbacks('B'));
  b.catch(() => {});
  await readyB.promise;

  // Both policy calls now own a pending context with the same provider id.
  // A's completed action must not clear B's still-pending approval context.
  releaseA.resolve(); await a;
  releaseB.resolve(); await b;

  assert.deepEqual(permissions, [
    { chat: 'A', sessionId: ids.A, callId, args: { chat: 'A' } },
    { chat: 'B', sessionId: ids.B, callId, args: { chat: 'B' } },
  ]);
  assert.deepEqual(starts, [{ chat: 'A', sessionId: ids.A, callId, args: { chat: 'A' } }]);
  assert.deepEqual(effects, [{ chat: 'A', args: { chat: 'A' } }]);
  for (const sessionId of Object.values(ids)) {
    const history = await driver.history(sessionId);
    assert.ok(history.events.some(event => event.type === 'tool/call' && event.data.callId === callId));
  }
  assert.deepEqual(failures, []);
});
