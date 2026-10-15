import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createCompatServer } from '../server.mjs';

test('shutdown rejects reconnects while native cleanup is still running', { timeout: 10000 }, async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const directory = await mkdtemp(path.join(tmpdir(), 'harness-shutdown-'));
  const server = await createCompatServer({ dataDir: directory, secret: 'isolated-shutdown-fixture', driver: {
    async close() { entered.resolve(); await release.promise; },
  } });
  const url = await server.listen(0, '127.0.0.1');
  const closing = server.close();
  await entered.promise;
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/acp?token=isolated-shutdown-fixture');
  let opened;
  try {
    opened = await new Promise(resolve => { ws.once('open', () => resolve(true)); ws.once('error', () => resolve(false)); });
  } finally { ws.terminate(); release.resolve(); await closing; }
  assert.equal(opened, false, 'the desktop reconnect loop must not keep a closing runtime alive');
});
