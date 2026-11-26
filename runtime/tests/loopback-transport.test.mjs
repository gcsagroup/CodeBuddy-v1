import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createCompatServer } from '../server.mjs';

// A cold Windows import of the real runtime can take over 15 seconds.
test('local backend authenticates independently of development port or file Origin', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cb-loopback-'));
  const secret = 'loopback-transport-test-secret';
  const service = await createCompatServer({ dataDir, secret, driver: { async close() {} } });
  const sockets = [];
  try {
    const base = await service.listen();
    assert.equal(new URL(base).hostname, '127.0.0.1');
    assert.equal((await fetch(base + '/status')).status, 401);
    assert.equal((await fetch(base + '/status', { headers: { 'X-Secret-Key': secret } })).status, 200);
    for (const origin of ['http://127.0.0.1:5174', 'null']) {
      const denied = new WebSocket(base.replace('http:', 'ws:') + '/acp?token=incorrect', { origin });
      sockets.push(denied);
      denied.on('error', () => {});
      const [, response] = await once(denied, 'unexpected-response');
      assert.equal(response.statusCode, 401);
      response.resume();
      denied.terminate();
      // Repeat a fresh connection: reconnecting must keep the same auth contract.
      for (let round = 0; round < 2; round++) {
        const ws = new WebSocket(base.replace('http:', 'ws:') + '/acp?token=' + secret, { origin });
        sockets.push(ws);
        await once(ws, 'open');
        const response = once(ws, 'message');
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: round + 1, method: 'initialize',
          params: { protocolVersion: 1, clientCapabilities: {} } }));
        const reply = JSON.parse(String((await response)[0]));
        assert.equal(reply.id, round + 1);
        assert.ok(reply.result, JSON.stringify(reply));
        ws.close();
        await once(ws, 'close');
      }
    }
  } finally {
    for (const ws of sockets) ws.terminate();
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
