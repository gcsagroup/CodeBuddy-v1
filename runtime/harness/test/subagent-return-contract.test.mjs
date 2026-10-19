import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHarnessDriver } from '../index.mjs';

// Run the real native loop, persistence, messaging and cancellation against a
// controlled model. This verifies delivery mechanics, not free-form model quality.
test('automatic native final delivery preserves optional coordination, role reuse and interrupted recovery', { timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-return-contract-'));
  await writeFile(join(root, 'checkpoint.txt'), 'checkpoint retained across interruption');
  const requests = [], failures = [], plans = new Map();
  const blocked = Promise.withResolvers();
  let blockedResponse, parentId, driver;
  const textOf = message => typeof message.content === 'string' ? message.content : (message.content ?? []).map(block => block.text ?? '').join('\n');
  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push(body);
      const child = body.messages.some(message => message.role === 'user' && textOf(message).includes('Your parent agent id is'));
      const marker = child ? /CHILD_TASK_\w+/ : /ROOT_ACTION_\d+/;
      const input = body.messages.findLastIndex(message => message.role === 'user' && marker.test(textOf(message)));
      const action = textOf(body.messages[input]).match(marker)?.[0];
      const since = body.messages.slice(input + 1);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: randomUUID(), model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      const call = (name, args) => {
        emit({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
        emit({}, 'tool_calls');
      };
      if (child) {
        const bootstrap = textOf(body.messages.find(message => message.role === 'user' && textOf(message).includes('Your parent agent id is')));
        assert.ok(bootstrap.includes('Your final response is automatically delivered'));
        assert.ok(!bootstrap.includes('Before you finish, send your result'));
        const toolResults = since.filter(message => message.role === 'tool');
        if (action === 'CHILD_TASK_COORDINATION' && toolResults.length === 0) {
          // Early messages remain native and optional; never suppress them as
          // duplicates merely because a final response will follow.
          call('send_message', { agent_id: parentId, message: 'EARLY_COORDINATION: a prerequisite needs parent attention.' });
        } else if (action === 'CHILD_TASK_INTERRUPTED') {
          if (toolResults.length === 0) call('read', { file_path: join(root, 'checkpoint.txt') });
          else { blockedResponse = res; res.flushHeaders(); blocked.resolve(); return; }
        } else {
          emit({ role: 'assistant', content: 'FINAL_' + action }); emit({}, 'stop');
        }
      } else if (!since.some(message => message.role === 'tool')) {
        const plan = plans.get(action); assert.ok(plan, `Missing plan for ${action}`); call(plan.name, plan.args);
      } else {
        const receivedFinal = since.some(message => message.role === 'user' && textOf(message).includes('Its closing message:'));
        emit({ role: 'assistant', content: receivedFinal ? 'ROOT_FINAL_RESULT' : 'ROOT_PROGRESS' }); emit({}, 'stop');
      }
      res.end('data: [DONE]\n\n');
    } catch (error) { failures.push(error); res.destroy(error); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = { id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-only', contextWindow: 32768 };
  const dataDir = join(root, 'native');
  t.after(async () => {
    blockedResponse?.destroy(); await driver?.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  });
  driver = await createHarnessDriver({ dataDir, cwd: root });
  ({ sessionId: parentId } = await driver.createSession({ provider, model: 'fixture' }));
  const tools = await driver.listTools(parentId);
  assert.ok(tools.find(tool => tool.name === 'subagent').description.includes('completion notice automatically includes'));
  let sequence = 0;
  async function action(name, args, signal) {
    const marker = `ROOT_ACTION_${++sequence}`; plans.set(marker, { name, args });
    const events = [], result = await driver.prompt(parentId, marker, { signal, onEvent: event => events.push(event), onPermission: () => true });
    return { result, events };
  }
  const childIdOf = round => round.events.find(event => event.type === 'tool_result' && event.structuredContent?.subagentId)?.structuredContent.subagentId;
  const finalCount = round => round.events.filter(event => event.type === 'text_delta' && event.sessionId === parentId && event.text === 'ROOT_FINAL_RESULT').length;
  const first = await action('subagent', { role: 'code reviewer', description: 'August review', prompt: 'CHILD_TASK_AUGUST' });
  const childId = childIdOf(first); assert.ok(childId);
  assert.equal(first.result.stopReason, 'end_turn'); assert.equal(finalCount(first), 1);
  const second = await action('send_message', { agent_id: childId, message: 'CHILD_TASK_JULY' });
  assert.equal(second.result.stopReason, 'end_turn'); assert.equal(finalCount(second), 1);
  assert.equal((await driver.listSubagentChildren(parentId)).length, 1);
  const historyAfter = await driver.history(parentId);
  const userMessages = historyAfter.events.filter(event => event.type === 'user/message').map(event => event.data);
  assert.equal(userMessages.filter(message => message.source?.kind === 'subagent-settled').length, 2);
  assert.equal(userMessages.filter(message => message.source?.kind === 'agent-message').length, 0, 'Final delivery must not require a second manual report');
  const july = requests.filter(body => body.messages.some(message => textOf(message).includes('CHILD_TASK_JULY')) && body.messages.some(message => textOf(message).includes('Your parent agent id is'))).at(-1);
  assert.ok(july.messages.some(message => textOf(message).includes('CHILD_TASK_AUGUST')));
  await driver.close();
  driver = await createHarnessDriver({ dataDir, cwd: root });
  await driver.createSession({ sessionId: parentId, provider, model: 'fixture' });
  const cold = await action('send_message', { agent_id: childId, message: 'CHILD_TASK_COLD_RESUME' });
  assert.equal(cold.result.stopReason, 'end_turn'); assert.equal(finalCount(cold), 1);
  const coordination = await action('send_message', { agent_id: childId, message: 'CHILD_TASK_COORDINATION' });
  assert.equal(coordination.result.stopReason, 'end_turn'); assert.equal(finalCount(coordination), 1);
  const historyCoordinated = await driver.history(parentId);
  assert.equal(historyCoordinated.events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'agent-message').length, 1);
  const controller = new AbortController();
  const pending = action('send_message', { agent_id: childId, message: 'CHILD_TASK_INTERRUPTED' }, controller.signal);
  pending.catch(() => {});
  await blocked.promise; controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.result.stopReason, 'cancelled');
  blockedResponse.destroy();
  const childBefore = await driver.history(childId);
  assert.ok(childBefore.events.some(event => event.type === 'tool/result' && JSON.stringify(event.data).includes('checkpoint retained across interruption')));
  const resumed = await action('send_message', { agent_id: childId, message: 'CHILD_TASK_RESUMED' });
  assert.equal(resumed.result.stopReason, 'end_turn'); assert.equal(finalCount(resumed), 1);
  const catalog = await driver.listSubagentChildren(parentId);
  assert.deepEqual(catalog.map(child => child.id), [childId]);
  const resumedRequest = requests.filter(body => body.messages.some(message => textOf(message).includes('CHILD_TASK_RESUMED')) && body.messages.some(message => textOf(message).includes('Your parent agent id is'))).at(-1);
  assert.ok(resumedRequest.messages.some(message => message.role === 'tool' && textOf(message).includes('checkpoint retained across interruption')));
  assert.equal(await readFile(join(root, 'checkpoint.txt'), 'utf8'), 'checkpoint retained across interruption');
  assert.deepEqual(failures, []);
});
