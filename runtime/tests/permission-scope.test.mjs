import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Compat } from '../compat.mjs';
import { openStore } from '../store.mjs';
import { SafetyPolicy } from '../safety-policy.mjs';
import { createHarnessDriver } from '../harness/index.mjs';

test('delegated working directory does not widen the inherited file sandbox outside temp roots', { timeout: 20000 }, async t => {
  const fixtures = fileURLToPath(new URL('../../.preview-data/', import.meta.url));
  const tempRelative = relative(tmpdir(), fixtures);
  if (!isAbsolute(tempRelative) && tempRelative !== '..' && !tempRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    t.skip('The checkout itself is under the platform temp grant; a non-temp fence fixture is unavailable');
    return;
  }
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(join(fixtures, 'permission-scope-'));
  const parentCwd = join(root, 'confirmed-project');
  const childCwd = join(root, 'different-project');
  await mkdir(parentCwd);
  await mkdir(childCwd);
  const model = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const user = body.messages.findLastIndex(message => message.role === 'user' && JSON.stringify(message.content).includes('SCOPE_FIXTURE_'));
    const isChild = JSON.stringify(body.messages[user]?.content).includes('SCOPE_FIXTURE_CHILD');
    const alreadyCalled = body.messages.slice(user + 1).some(message => message.role === 'tool');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason) => res.write(`data: ${JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (!alreadyCalled) {
      const name = isChild ? 'write' : 'subagent';
      const args = isChild ? { file_path: join(childCwd, 'must-not-write.txt'), content: 'unexpected automatic grant' }
        : { description: 'Independent workspace fixture', cwd: childCwd, prompt: 'SCOPE_FIXTURE_CHILD' };
      emit({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null);
      emit({}, 'tool_calls');
    } else {
      emit({ role: 'assistant', content: 'Scope fixture finished.' }, null);
      emit({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const driver = await createHarnessDriver({ dataDir: join(root, 'native'), cwd: root });
  t.after(async () => { await driver.close(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); });
  const id = randomUUID();
  await driver.createSession({ sessionId: id, cwd: parentCwd,
    provider: { id: 'scope-fixture', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fixture-only', protocol: 'openai-completions' }, model: 'fixture-model' });
  const store = await openStore(join(root, 'host'));
  const session = { id, cwd: parentCwd, mode: 'smart_approve', type: 'code_pro', workspaceBinding: 'writable_project', updates: [] };
  await store.update(state => state.sessions.push(session));
  // The fixture starts with an already-confirmed root. Exercise the real
  // permission owner and native child routing without an unrelated UI setup.
  const host = Object.assign(Object.create(Compat.prototype), { store, settings: { extensions: async () => [] }, active: new Map(), safety: new SafetyPolicy(store) });
  const questions = [], calls = [], events = [];
  const connection = { async ask(_method, params) {
    questions.push(params.toolCall.title);
    return { outcome: { outcome: 'selected', optionId: params.toolCall.title === 'subagent' ? 'allow_once' : 'reject_once' } };
  } };
  await driver.prompt(id, 'SCOPE_FIXTURE_PARENT', { onEvent: event => events.push(event), onToolPolicy: call => {
    calls.push(call);
    return host.toolPolicy(session, call, call.signal);
  }, onPermission: call => host.approveTool(session, call, connection, call.signal) });
  assert.ok(calls.some(call => call.name === 'write' && call.sessionId !== id), 'Exercise an actual native child write proposal');
  assert.ok(calls.some(call => call.name === 'subagent' && call.delegationControl === true));
  assert.deepEqual(questions, [], 'Internal delegation needs no duplicate confirmation, and the file operation still reaches its inherited native fence');
  assert.ok(events.some(event => event.type === 'tool_result' && event.name === 'write' && event.isError && /sandbox.*denied|FS_SANDBOX_DENIED/i.test(JSON.stringify(event))));
  await assert.rejects(access(join(childCwd, 'must-not-write.txt')));
});
