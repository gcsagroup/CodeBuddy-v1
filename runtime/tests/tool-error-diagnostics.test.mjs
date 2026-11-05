import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { createHarnessDriver } from '../harness/index.mjs';

test('native tool errors retain bounded safe transport causes without serializing secrets', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-error-diagnostics-'));
  const driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd: root });
  t.after(async () => {
    await driver.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('codebuddy-error-diagnostics-'));
    await rm(root, { recursive: true, force: true });
  });
  const portProbe = createServer();
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const session = await driver.createSession({ cwd: root, provider: { id: 'offline', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '' }, model: 'offline', options: { tools: [{
    name: 'network_probe', inputSchema: { type: 'object', properties: { aggregate: { type: 'boolean' } } },
    async execute({ aggregate }) {
      if (aggregate) {
        const cause = Object.assign(new Error('DO_NOT_LOG_TOKEN'), { code: 'CERT_HAS_EXPIRED', address: 'private-host', stack: 'DO_NOT_LOG_STACK' });
        cause.cause = cause;
        throw new Error('TLS request failed', { cause: new AggregateError([cause, cause]) });
      }
      await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(3000) });
    },
  }] } });
  const call = aggregate => driver.callTool(session.sessionId, 'network_probe', { aggregate }, { onToolPolicy: () => ({ kind: 'allow' }) });
  const refused = await call(false);
  assert.equal(refused.isError, true);
  assert.deepEqual(refused.error.info.causes, [{ code: 'ECONNREFUSED' }]);
  assert.match(JSON.stringify(refused.content), /ECONNREFUSED/);
  const tls = await call(true);
  assert.deepEqual(tls.error.info.causes, [{ code: 'CERT_HAS_EXPIRED' }]);
  assert.doesNotMatch(JSON.stringify(tls), /DO_NOT_LOG|private-host/);
});
