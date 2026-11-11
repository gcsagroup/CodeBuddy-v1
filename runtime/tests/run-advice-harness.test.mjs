import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessDriver } from '../harness/index.mjs';
import { workStatusUpdates } from '../work-status.mjs';

test('native failed commands supply advice facts without treating MCP delivery as command success', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cb-run-advice-'));
  const cancel = new AbortController(), receipts = [], counts = [];
  let requests = 0;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = JSON.parse(raw); requests++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = { tool_calls: [{ index: 0, id: `command-${requests}`, type: 'function', function: {
      name: process.platform === 'win32' ? 'pwsh' : 'bash',
      arguments: JSON.stringify({ command: 'exit 7', description: 'Expected failure for advice acceptance' }),
    } }] };
    res.end('data: ' + JSON.stringify({ id: 'fixture', model: body.model, choices: [{ index: 0, delta, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const driver = await createHarnessDriver({ cwd: root, dataDir: join(root, 'state') });
  t.after(async () => { await driver.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const session = await driver.createSession({ cwd: root, model: 'advice-fixture', provider: {
    id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture',
  } });
  const project = workStatusUpdates({ sessionId: session.sessionId, sourceMessageId: 'fixture-user', runId: 'fixture-run' });
  await driver.prompt(session.sessionId, 'Execute the supplied diagnostic commands. Their nonzero exits are expected.', {
    signal: cancel.signal, onPermission: () => true,
    onEvent(event) {
      const updates = project(event);
      if (event.type !== 'tool_result') return;
      receipts.push(event);
      counts.push(updates.at(-1)?.status.data.consecutive_tool_failures);
      if (receipts.length === 3) cancel.abort();
    },
  });
  assert.equal(receipts.length, 3);
  assert(receipts.every(event => event.executionFailed === true), JSON.stringify(receipts));
  assert.deepEqual(counts, [1, 2, 3]);
  assert.equal(requests, 3, 'Advice facts must not issue additional inference requests');
});
