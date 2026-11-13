import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessDriver } from '../harness/index.mjs';
import { Compat } from '../compat.mjs';
import { openStore } from '../store.mjs';
import { createConversationDriver } from '../conversation-driver.mjs';
import { replyToNoActionReview } from '../harness/test/review-fixture.mjs';

test('cold replay restores a failure after child settlement to its initiating request', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'codebuddy-child-terminal-'));
  const childReady = Promise.withResolvers();
  let parentRequests = 0, childRequests = 0, releaseChild, compat, driver;
  const endpoint = createServer(async (req, res) => {
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'fixture', context_window: 65536 }] }));
    let raw = ''; for await (const bytes of req) raw += bytes;
    const body = JSON.parse(raw);
    if (replyToNoActionReview(body, res)) return;
    if (!body.stream) return res.end(JSON.stringify({ choices: [{ message: { content: 'Synthetic child test' } }] }));
    const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'child-test', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    const finish = text => {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); emit({ content: text }); emit({}, 'stop'); res.end('data: [DONE]\n\n');
    };
    // Fixture routing only: the protocol request is authored by the real child Host.
    if (body.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('Your parent agent id is'))) {
      childRequests++; releaseChild = () => finish('Synthetic child completed'); childReady.resolve(); return;
    }
    if (++parentRequests === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      emit({ tool_calls: [{ index: 0, id: 'delegate-once', type: 'function', function: {
        name: 'subagent_explorer', arguments: JSON.stringify({ description: 'Synthetic child', prompt: 'Return a synthetic result.' }),
      } }] }); emit({}, 'tool_calls'); return res.end('data: [DONE]\n\n');
    }
    if (parentRequests === 2) return finish('Waiting for the existing child.');
    res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'invalid_api_key', message: 'PRIVATE_CHILD_AUTH' } }));
  });
  await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
  t.after(async () => { releaseChild?.(); await compat?.close(); endpoint.closeAllConnections(); await new Promise(r => endpoint.close(r)); });
  const store = await openStore(path.join(root, 'data'));
  await store.update(s => {
    s.providers = [{ id: 'fixture', engine: 'openai_compatible', apiUrl: `http://127.0.0.1:${endpoint.address().port}`, models: ['fixture'], requiresAuth: false }];
    s.defaults = { providerId: 'fixture', modelId: 'fixture' };
  });
  const open = async () => {
    driver = await createHarnessDriver({ dataDir: path.join(root, 'native'), cwd: root });
    compat = new Compat(store, createConversationDriver(driver, store)); await compat.initialize();
  };
  await open();
  let wire = [];
  const connection = { notify(_method, value) { wire.push(value); }, async ask() { return { outcome: { outcome: 'selected', optionId: 'allow_once' } }; } };
  const terminals = () => wire.flatMap(x => x.update?.status?.data?.terminal_message_id ? [x.update.status.data] : []);
  const { sessionId } = await compat.request('session/new', { cwd: root, mcpServers: [], _meta: { enabledExtensions: ['developer'] } }, connection);
  const running = compat.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Run one child and report the result.' }],
    _meta: { 'codeagentpro/source-message-id': 'initial-user' } }, connection).catch(e => e);
  await childReady.promise;
  const deadline = Date.now() + 5000;
  while (!(await driver.history(sessionId)).events.some(e => e.type === 'turn/end' && e.data.reason.kind === 'completed')) {
    assert.ok(Date.now() < deadline, 'The first parent turn must finish before releasing the child');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const release = releaseChild; releaseChild = undefined; release();
  assert.equal((await running).code, 'AUTH');
  assert.equal(terminals().length, 1); assert.equal(terminals()[0].diagnostic.code, 'AUTH');
  const original = await driver.exportSessionLog(sessionId);
  assert.equal(original.split('\n').filter(Boolean).map(JSON.parse).filter(e => e.type === 'tool/call').length, 1);
  await compat.close();
  // Only discard this fixture's display projection, reproducing an older version.
  // The complete native journal, including delegation and failure, stays intact.
  await store.updateSession(sessionId, s => { s.usageUpdates = s.usageUpdates.filter(u => !u.status?.data?.terminal_message_id); });
  await open();
  for (let i = 0; i < 2; i++) {
    wire = []; await compat.request('session/load', { sessionId }, connection);
    assert.deepEqual(terminals().map(d => [d.source_user_message_id, d.diagnostic.code]), [['initial-user', 'AUTH']]);
    assert.equal(JSON.stringify(wire).includes('PRIVATE_CHILD_AUTH'), false);
  }
  assert.equal(parentRequests, 3); assert.equal(childRequests, 1);
  assert.ok((await driver.exportSessionLog(sessionId)).startsWith(original), 'Cold replay must preserve every native event');
});
