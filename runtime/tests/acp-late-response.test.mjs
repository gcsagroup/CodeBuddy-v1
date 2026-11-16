import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createCompatServer } from '../server.mjs';
import { permissionDriver } from './fixtures/permission-driver.mjs';

test('late/duplicate ACP answers receive no response-to-response; malformed requests still fail', { timeout: 15000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cb-acp-late-response-'));
  const secret = 'local-late-response-fixture';
  const service = await createCompatServer({ dataDir, secret, driver: { permissions: permissionDriver(), async close() {} } });
  const url = await service.listen(0, '127.0.0.1');
  const ws = new WebSocket(url.replace(/^http/, 'ws') + '/acp?token=' + secret);
  t.after(async () => { ws.close(); await service.close(); });
  const messages = [];
  ws.addEventListener('message', event => messages.push(JSON.parse(String(event.data))));
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  const send = body => ws.send(JSON.stringify({ jsonrpc: '2.0', ...body }));
  const wait = async id => { const deadline = Date.now() + 4000; while (!messages.some(m => m.id === id) && Date.now() < deadline) await delay(5); const found = messages.find(m => m.id === id); assert(found, 'RPC barrier completed'); return found; };
  send({ id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
  assert((await wait(1)).result);
  send({ id: 'finished-decision', result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } });
  send({ id: 'finished-decision', result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } });
  send({ id: 'cancelled-decision', error: { code: -32800, message: 'Cancelled' } });
  send({ id: 2, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
  await wait(2);
  assert.deepEqual(messages.filter(m => ['finished-decision', 'cancelled-decision'].includes(m.id)), [],
    'a settled or cancelled decision cannot start a new error exchange');
  send({ id: 3 });
  assert.equal((await wait(3)).error.code, -32600);
});
