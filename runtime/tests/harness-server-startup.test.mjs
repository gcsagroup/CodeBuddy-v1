import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../store.mjs';
import { RuntimeSettings } from '../settings.mjs';
import { CodeProRuns } from '../codepro.mjs';
import { CodeProReviews } from '../codepro-review.mjs';
import { createCompatServer } from '../server.mjs';
import { acquireProfileLock } from '../profile-lock.mjs';
const run = promisify(execFile);

test('saved title recovery does not gate readiness and shutdown still drains its owner', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codebuddy-startup-titles-'));
  const store = await openStore(directory);
  await store.update(state => state.sessions.push({ id: 'old', title: '新对话', messageCount: 2 }));
  const lookup = Promise.withResolvers();
  let nativeClosed = false;
  const app = await createCompatServer({ dataDir: directory, secret: 'isolated-title-startup', driver: {
    listSessions: () => lookup.promise,
    async close() { nativeClosed = true; },
  } });
  t.after(async () => { lookup.resolve([]); await app.close(); await rm(directory, { recursive: true, force: true }); });
  assert.match(await app.listen(), /^http:/);
  const closing = app.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nativeClosed, false, 'Native owner stays alive while admitted title inspection settles');
  lookup.resolve([{ sessionId: 'old', projections: { values: { title: 'Recovered title' } } }]);
  await closing;
  assert.equal(nativeClosed, true);
  assert.equal((await openStore(directory)).readSession('old').title, '新对话', 'Shutdown cancels pending title changes');
});

test('a damaged profile fails startup and releases its lease after runtime loading', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'codebuddy-startup-invalid-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(path.join(dataDir, 'state.json'), 'truncated');
  let runtimeLoaded = false;
  await assert.rejects(createCompatServer({ dataDir, secret: 'isolated-startup-test', onRuntimeLoaded() {
    runtimeLoaded = true;
  } }), SyntaxError);
  assert.equal(runtimeLoaded, true);
  const lease = await acquireProfileLock(dataDir);
  lease.close();
});

test('restarting a healthy profile does not rewrite history; interrupted reviews still recover once', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codebuddy-startup-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let writes = 0;
  const boot = async () => {
    const store = await openStore(directory, { replaceFile: async (from, to) => {
      await rename(from, to);
      writes++;
    } });
    await new RuntimeSettings(store).initialize();
    await new CodeProRuns(store).initialize();
    await new CodeProReviews(store, {}).initialize();
    return store;
  };
  const initial = await boot();
  await initial.update(state => {
    state.sessions.push({ id: 'existing', title: 'Saved conversation' });
    state.reviews.records.previous = { result: { status: 'running', revision: 1 } };
  });
  writes = 0;
  const recovered = await boot();
  assert.equal(writes, 1);
  assert.equal(recovered.read(['reviews']).reviews.records.previous.result.status, 'interrupted');
  writes = 0;
  const clean = await boot();
  assert.equal(writes, 0);
  assert.equal(clean.readSession('existing').title, 'Saved conversation');
  assert.equal(clean.read(['reviews']).reviews.records.previous.result.revision, 2);
});

test('the real server import graph can boot its lazily loaded native driver', { timeout: 15000 }, async () => {
  const script = `
    await import('./runtime/server.mjs');
    const { createHarnessDriver } = await import('./runtime/harness/index.mjs');
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dataDir = await mkdtemp(join(tmpdir(), 'codebuddy-server-contract-'));
    const driver = await createHarnessDriver({ dataDir });
    await driver.close();
    console.log('SERVER_NATIVE_BOOT_OK');
  `;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('../../', import.meta.url), timeout: 12000,
  });
  assert.match(stdout, /SERVER_NATIVE_BOOT_OK/);
});
