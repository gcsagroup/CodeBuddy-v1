import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createCompatServer } from '../server.mjs';
import { openStore } from '../store.mjs';
import { permissionDriver } from './fixtures/permission-driver.mjs';
import { workspaceIdentity } from '../workspaces.mjs';

test('real ACP wire protects model errors, keeps failure facts after load and never re-executes on load', { timeout: 30000 }, async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'codebuddy-safe-error-')));
  const endpoint = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('/models') ? { data: [{ id: 'fixture' }] } : { choices: [{ message: { content: 'OK' } }] }));
  });
  await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
  t.after(() => { endpoint.closeAllConnections(); endpoint.close(); });
  const store = await openStore(path.join(directory, 'data'));
  await store.update(state => {
    state.providers = [{ id: 'fixture', engine: 'openai_compatible', apiUrl: `http://127.0.0.1:${endpoint.address().port}`,
      models: ['fixture'], requiresAuth: false, headers: {}, supportsStreaming: true }];
    state.defaults = { providerId: 'fixture', modelId: 'fixture' };
    state.preferences.gooseMode = 'auto';
  });
  let failure, executions = 0;
  const secret = 'isolated-error-wire-secret';
  const server = await createCompatServer({ dataDir: path.join(directory, 'data'), secret, driver: {
    permissions: permissionDriver(), async createSession() {}, async listTools() { return []; },
    async prompt(_id, _content, options) {
      executions++;
      if (failure) throw failure;
      await options.onEvent({ type: 'text_delta', text: 'Recovered after inspection.' });
      return { stopReason: 'end_turn', reason: { kind: 'completed' } };
    }, async cancel() {}, async close() {},
  } });
  t.after(() => server.close());
  const url = await server.listen(0, '127.0.0.1');
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/acp?token=' + secret);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  t.after(() => ws.terminate());
  const pending = new Map(), wire = [];
  let id = 0;
  ws.on('message', bytes => {
    const value = JSON.parse(String(bytes)); wire.push(value);
    const waiter = pending.get(value.id);
    if (waiter) { pending.delete(value.id); waiter.resolve(value); }
  });
  const rpc = (method, params = {}) => {
    const waiter = Promise.withResolvers(), requestId = ++id;
    pending.set(requestId, waiter);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }));
    return waiter.promise;
  };
  await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const cwd = path.join(directory, 'project');
  const lease = await rpc('_goose/unstable/workspace/lease/acquire', { requestedPath: cwd, expectedState: 'missing', expectedIdentity: workspaceIdentity(cwd) });
  assert.ok(lease.result?.leaseId);
  const created = await rpc('session/new', { cwd, mcpServers: [], _meta: { workspaceMode: 'codepro', workspaceLeaseId: lease.result.leaseId } });
  assert.ok(created.result?.sessionId);
  const sessionId = created.result.sessionId;
  const prompt = () => rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Continue isolated fixture' }] });
  for (const [code, status] of [['AUTH', 401], ['QUOTA', 429], ['RATE_LIMIT', 429], ['CONTEXT_WINDOW_EXCEEDED', 400], ['PI_AI_ERROR', undefined]]) {
    failure = Object.assign(new Error('PRIVATE_PROVIDER_PAYLOAD https://private.invalid/?key=PRIVATE_PROVIDER_PAYLOAD'), {
      code, ...(status ? { status } : {}), cause: { headers: { authorization: 'PRIVATE_PROVIDER_PAYLOAD' } },
    });
    const before = executions;
    const response = await prompt();
    assert.ok(response.error);
    assert.equal(response.error.data.diagnostic.code, code);
    assert.equal(response.error.data.diagnostic.httpStatus, status);
    assert.equal(executions, before + 1);
    await rpc('session/load', { sessionId });
    assert.equal(executions, before + 1, 'history loading does not create model or tool actions');
    const terminal = wire.flatMap(value => value.params?.update?.status?.data?.terminal_message_id ? [value.params.update.status.data] : []).at(-1);
    assert.equal(terminal.status, 'failed');
    assert.equal(terminal.retry_strategy, 'not_available');
    assert.equal(terminal.diagnostic.code, code);
    assert.equal(terminal.diagnostic.httpStatus, status);
    assert.equal(JSON.stringify(wire).includes('PRIVATE_PROVIDER_PAYLOAD'), false);
    assert.equal(failure.code, code, 'native exception is unchanged by presentation');
  }
  failure = undefined;
  const recovered = await prompt();
  assert.equal(recovered.result?.stopReason, 'end_turn');
  assert.ok(wire.some(value => value.params?.update?.content?.text === 'Recovered after inspection.'));
});
