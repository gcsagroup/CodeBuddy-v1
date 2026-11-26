import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createServer, loadConfigFromFile } from 'vite';

test('renderer advertises a reachable IPv4 loopback URL for Electron', async () => {
  const configPath = fileURLToPath(new URL('../vite.renderer.config.mts', import.meta.url));
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, configPath);
  assert.equal(loaded.config.server.host, '127.0.0.1');
  const server = await createServer({
    configFile: false,
    server: { ...loaded.config.server, port: 0, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [{
      name: 'loopback-receipt',
      configureServer(instance) {
        instance.middlewares.use('/__loopback', (_req, res) => res.end('renderer-ready'));
      },
    }],
  });
  try {
    await server.listen();
    const url = new URL('__loopback', server.resolvedUrls.local[0]);
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(await (await fetch(url)).text(), 'renderer-ready');
  } finally {
    await server.close();
  }
});

test('occupied ports retain IPv4 and deliver real hot updates on the selected port', { timeout: 15000 }, async () => {
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' },
    fileURLToPath(new URL('../vite.renderer.config.mts', import.meta.url)));
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-hmr-'));
  const occupied = createHttpServer();
  let server, socket;
  try {
    await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
    const port = occupied.address().port;
    await writeFile(join(root, 'hot.js'), 'export const value = 1; if (import.meta.hot) import.meta.hot.accept();');
    server = await createServer({ configFile: false, root,
      server: { ...loaded.config.server, port },
      optimizeDeps: { noDiscovery: true, include: [] } });
    await server.listen();
    const origin = server.resolvedUrls.local[0];
    assert.equal(new URL(origin).hostname, '127.0.0.1');
    assert.notEqual(Number(new URL(origin).port), port);
    const client = await (await fetch(new URL('@vite/client', origin))).text();
    assert.ok(!client.includes('"localhost"'), 'HMR must not reintroduce localhost DNS');
    const token = server.config.webSocketToken;
    socket = new WebSocket(origin.replace('http:', 'ws:') + '?token=' + token, 'vite-hmr', { origin: new URL(origin).origin });
    await once(socket, 'open');
    await server.transformRequest('/hot.js');
    const update = new Promise(resolve => socket.on('message', data => {
      const event = JSON.parse(String(data));
      if (event.type === 'update') resolve(event);
    }));
    await writeFile(join(root, 'hot.js'), 'export const value = 2; if (import.meta.hot) import.meta.hot.accept();');
    const event = await update;
    assert.equal(event.updates[0].path, '/hot.js');
    assert.match(await (await fetch(new URL('hot.js', origin))).text(), /value = 2/);
  } finally {
    socket?.terminate();
    await server?.close();
    await new Promise(resolve => occupied.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
