import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { access, rm, mkdtemp } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WindowsSessionTemps } from '../../harness/windows-session-temps.mjs';

const blockTag = 'codebuddy-fixture-ipc-block';
const ackTag = 'codebuddy-fixture-ipc-block-ack';
const preload = Buffer.from(`
process.on('message', message => {
  if (message?.type !== ${JSON.stringify(blockTag)}) return;
  process.send({ type: ${JSON.stringify(ackTag)} }, error => {
    if (error) process.exit(72);
    // Let the genuine IPC handle close. Stall only the helper's ensuing clean exit.
    const exit = process.exit;
    process.exit = function fixtureExit(code) {
      process.exit = exit;
      if (code !== 0) return exit.call(this, code);
      setTimeout(() => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
        exit.call(process, 0);
      }, 25);
    };
    process.disconnect();
  });
});
`).toString('base64');
const resourceScript = fileURLToPath(new URL('../../harness/windows-session-temps-process.mjs', import.meta.url));
const workspaceRoot = await mkdtemp(join(tmpdir(), 'codebuddy-resource-ipc-'));
const resources = new WindowsSessionTemps();
const grants = new Set();
const originalSpawn = childProcess.spawn;
let injected = false, old;

function within(promise, ms, fallback) {
  let timer;
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms, fallback); })])
    .finally(() => clearTimeout(timer));
}

async function acquire(sessionId, ms = 5000) {
  const capability = await resources.acquire({ sessionId, workspaceRoot }, undefined, performance.now() + ms);
  grants.add(capability.dir);
  return capability;
}

function captureOutcome(promise) {
  return promise.then(value => ({ value }), error => ({ error }));
}

function restoreSpawn() {
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
}

childProcess.spawn = function fixtureSpawn(command, args, options) {
  if (injected || command !== process.execPath || args[0] !== resourceScript)
    return originalSpawn.apply(this, arguments);
  injected = true;
  const env = { ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=data:text/javascript;base64,${preload}`].filter(Boolean).join(' ') };
  return originalSpawn.call(this, command, args, { ...options, env });
};
syncBuiltinESMExports();

try {
  const initial = await acquire('ipc-initial');
  assert.equal(injected, true);
  restoreSpawn();
  old = resources.worker;
  let oldClosed = false;
  old.closed.then(() => { oldClosed = true; });

  const disconnected = new Promise(resolve => old.child.once('disconnect', () => resolve(true)));
  const ack = new Promise((resolve, reject) => {
    const message = value => {
      if (value?.type !== ackTag) return;
      old.child.off('message', message);
      resolve(true);
    };
    old.child.on('message', message);
    old.child.send({ type: blockTag }, error => { if (error) reject(error); });
  });
  assert.equal(await within(ack, 2000, false), true, 'resource child did not ack the isolated block');
  assert.equal(resources.pending.size, 0);
  assert.equal(oldClosed, false);
  assert.equal(await within(disconnected, 2000, false), true, 'parent did not see IPC EOF');
  const started = performance.now();
  const { error } = await captureOutcome(acquire('ipc-lost'));
  assert.equal(error?.code, 'ERR_IPC_CHANNEL_CLOSED');
  const servingFailedOwner = resources.worker === old;
  const oldOwnerFenced = resources.retiring === old || oldClosed;
  console.log('DISCONNECTED: callback=%s activeOwner=%s retiringOwner=%s cached=%s childClosed=%s',
    error.code, resources.worker === old, resources.retiring === old, resources.capabilities.size, oldClosed);

  const closedByBudget = await within(old.closed.then(() => true), 1500, false);
  if (!closedByBudget) {
    const retry = await captureOutcome(acquire('ipc-retry', 300));
    console.log('NO_RECOVERY: retry=%s activeOwner=%s childClosed=%s elapsedMs=%s',
      retry.error?.code, resources.worker === old, oldClosed, Math.round(performance.now() - started));
    assert.equal(retry.error?.code, 'ERR_IPC_CHANNEL_CLOSED');
  }
  assert.equal(closedByBudget, true, 'the disconnected owner did not retire within the recovery budget');
  assert.equal(servingFailedOwner, false);
  assert.equal(oldOwnerFenced, true);
  await access(initial.dir); // A transport fault cannot revoke grants used by old commands.
  const remaining = 5000 - (performance.now() - started);
  assert.ok(remaining > 0);
  const replacement = await acquire('ipc-retry', remaining);
  await access(replacement.dir);
  assert.notEqual(replacement.dir, initial.dir);
  assert.notEqual(resources.worker, old);
  assert.ok(performance.now() - started < 5000);
  console.log('IPC_TRANSPORT_FAILURE_RETIRED_AND_RECOVERED');
} finally {
  restoreSpawn();
  for (const worker of new Set([old, resources.worker, resources.retiring])) worker?.releaseJob?.();
  try { await resources.close(false); }
  finally {
    const ownedRoot = relative(tmpdir(), resolve(workspaceRoot));
    assert.ok(ownedRoot.startsWith('codebuddy-resource-ipc-') && !isAbsolute(ownedRoot) && !ownedRoot.includes(sep));
    await rm(workspaceRoot, { recursive: true, force: true });
    for (const dir of grants) {
      const child = relative(tmpdir(), resolve(dir));
      assert.ok(child.startsWith('dsh-') && !isAbsolute(child) && !child.includes(sep));
      await rm(dir, { recursive: true, force: true });
    }
  }
}
