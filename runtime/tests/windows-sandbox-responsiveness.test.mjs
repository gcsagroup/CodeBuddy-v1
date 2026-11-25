import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, access, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHarnessDriver } from '../harness/index.mjs';

const { default: WindowsSandboxProvider } = await import('../harness/windows-sandbox.mjs');
const harnessRequire = createRequire(new URL('../harness/package.json', import.meta.url));
const { Context } = await import(pathToFileURL(harnessRequire.resolve('@deepseek-ai/cordis')));

test('an ACL preparation wait cannot block another session or cancellation, and never dispatches after stop', {
  skip: process.platform !== 'win32', timeout: 30000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-sandbox-responsive-'));
  const project = join(root, 'project'); await mkdir(project);
  const driver = await createHarnessDriver({ dataDir: join(root, 'native'), cwd: project });
  let holder;
  t.after(async () => {
    if (holder?.exitCode === null) { const exit = once(holder, 'exit'); holder.kill(); await exit; }
    await driver.close();
    await rm(root, { recursive: true, force: true });
  });
  const configuration = { cwd: project, provider: { id: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-only' }, model: 'fixture' };
  const { sessionId } = await driver.createSession(configuration);
  // Warm the process without creating a workspace grant. Cancellation below
  // must interrupt a live native wait, rather than only process startup.
  await driver.permissions(sessionId, { preset: 'read-only' });
  const warm = await driver.callTool(sessionId, 'pwsh', { command: 'Write-Output READY', description: 'Warm isolated read-only sandbox' }, { onPermission: () => true });
  assert.equal(warm.isError, false, JSON.stringify(warm));
  await driver.permissions(sessionId, { preset: 'workspace-write' });
  // Use the pinned native package's real cross-process lock. No busy-loop or
  // mock executor: this is the same synchronous Win32 wait as a large grant.
  const lockDir = join(tmpdir(), 'dsh-acl-locks'); await mkdir(lockDir, { recursive: true });
  const lockPath = join(lockDir, createHash('sha256').update(project.toLowerCase()).digest('hex').slice(0, 16) + '.lock');
  holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$f=[IO.File]::Open($env:CB_LOCK,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite); $f.Lock(0,1); [Console]::WriteLine('LOCKED'); Start-Sleep -Milliseconds 2000; $f.Unlock(0,1); $f.Dispose()"],
  { windowsHide: true, env: { ...process.env, CB_LOCK: lockPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  await once(holder.stdout, 'data');
  const controller = new AbortController();
  const started = performance.now();
  const pending = driver.callTool(sessionId, 'pwsh', {
    command: "Set-Content -LiteralPath 'must-not-execute.txt' -Value 'unexpected'", description: 'Cancelled sandbox preparation fixture',
  }, { signal: controller.signal, onPermission: () => true }).then(value => ({ value }), error => ({ error }));
  await delay(150);
  const other = await driver.createSession(configuration);
  controller.abort();
  await pending;
  assert.ok(performance.now() - started < 1000, 'another session and Stop must respond before the native lock is released');
  assert.notEqual(other.sessionId, sessionId);
  await once(holder, 'exit');
  // A late preparation reply must not replay the cancelled shell operation.
  const next = await driver.callTool(other.sessionId, 'pwsh', { command: 'Write-Output STILL_RESPONSIVE', description: 'Check the next sandbox call' }, { onPermission: () => true });
  assert.equal(next.isError, false, JSON.stringify(next));
  assert.equal(next.value.exitCode, 0, JSON.stringify(next));
  await assert.rejects(access(join(project, 'must-not-execute.txt')));
});

test('a sandbox preparation process failure fails closed and a subsequent call can recover', {
  skip: process.platform !== 'win32', timeout: 15000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-sandbox-failure-'));
  const context = new Context();
  const plugin = context.plugin(WindowsSandboxProvider, {}); await plugin;
  t.after(async () => { await plugin.dispose(); await rm(root, { recursive: true, force: true }); });
  const policy = { mode: 'read-only', workspaceRoot: root, sessionId: 'crash-fixture' };
  const pending = context.sandbox.confine(['pwsh.exe', '-Command', 'Write-Output SHOULD_NOT_START'], policy);
  const rejected = assert.rejects(pending, error => error.code === 'SANDBOX_UNAVAILABLE');
  [...context.sandbox.workers.values()][0].child.kill();
  await rejected;
  const recovered = await context.sandbox.confine(['pwsh.exe'], policy);
  assert.notDeepEqual(recovered.argv, ['pwsh.exe'], 'recovery must still use the restricted runner');
});

async function holdWorkspaceLock(root) {
  const lockDir = join(tmpdir(), 'dsh-acl-locks'); await mkdir(lockDir, { recursive: true });
  const lockPath = join(lockDir, createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 16) + '.lock');
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$f=[IO.File]::Open($env:CB_LOCK,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite); $f.Lock(0,1); [Console]::WriteLine('LOCKED'); [void][Console]::ReadLine(); $f.Unlock(0,1); $f.Dispose()"],
  { windowsHide: true, env: { ...process.env, CB_LOCK: lockPath }, stdio: ['pipe', 'pipe', 'pipe'] });
  const [ready] = await once(holder.stdout, 'data');
  assert.match(ready.toString(), /LOCKED/);
  return async () => {
    if (holder.exitCode !== null || holder.signalCode !== null) return;
    const exited = once(holder, 'exit'); holder.stdin.end('\n'); await exited;
  };
}

test('one blocked workspace cannot hold another workspace shell behind its preparation', {
  skip: process.platform !== 'win32', timeout: 15000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-sandbox-isolation-'));
  const a = join(root, 'a'), b = join(root, 'b'); await mkdir(a); await mkdir(b);
  const context = new Context(); const plugin = context.plugin(WindowsSandboxProvider, {}); await plugin;
  let release;
  t.after(async () => { await release?.(); await plugin.dispose(); await rm(root, { recursive: true, force: true }); });
  const policy = workspaceRoot => ({ mode: 'read-only', workspaceRoot, sessionId: 'isolation' });
  await context.sandbox.confine(['pwsh.exe'], policy(a));
  await context.sandbox.confine(['pwsh.exe'], policy(b));
  release = await holdWorkspaceLock(a);
  const controller = new AbortController();
  const waiting = context.sandbox.confine(['pwsh.exe'], { ...policy(a), mode: 'workspace-write' }, controller.signal);
  const cancelled = assert.rejects(waiting, error => error.name === 'AbortError');
  await delay(100);
  try {
    const ready = await Promise.race([
      context.sandbox.confine(['pwsh.exe'], policy(b)),
      delay(1500).then(() => { throw new Error('a healthy workspace shell waited behind another workspace native lock'); }),
    ]);
    assert.notDeepEqual(ready.argv, ['pwsh.exe']);
  } finally { controller.abort(); await cancelled; }
});

test('preparation has its own deadline and recovers after the native lock is released', {
  skip: process.platform !== 'win32', timeout: 15000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-sandbox-deadline-'));
  const context = new Context(); const plugin = context.plugin(WindowsSandboxProvider, {}); await plugin;
  let release;
  t.after(async () => { await release?.(); await plugin.dispose(); await rm(root, { recursive: true, force: true }); });
  const policy = { mode: 'read-only', workspaceRoot: root, sessionId: 'deadline' };
  await context.sandbox.confine(['pwsh.exe'], policy);
  context.sandbox.internals.preparationTimeoutMs = 500;
  release = await holdWorkspaceLock(root);
  await assert.rejects(Promise.race([
    context.sandbox.confine(['pwsh.exe'], { ...policy, mode: 'workspace-write' }),
    delay(2500).then(() => { throw new Error('preparation deadline did not settle its caller'); }),
  ]), error => error.code === 'SANDBOX_UNAVAILABLE' && /not started/.test(error.message));
  await release();
  context.sandbox.internals.preparationTimeoutMs = 10000;
  const recovered = await context.sandbox.confine(['pwsh.exe'], policy);
  assert.notDeepEqual(recovered.argv, ['pwsh.exe']);
});

test('cancelling a queued preparation preserves its active neighbour and read-only access stays available', {
  skip: process.platform !== 'win32', timeout: 15000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-sandbox-queue-'));
  const context = new Context(); const plugin = context.plugin(WindowsSandboxProvider, {}); await plugin;
  const release = await holdWorkspaceLock(root);
  const active = new AbortController(), queued = new AbortController();
  t.after(async () => { active.abort(); await release(); await plugin.dispose(); await rm(root, { recursive: true, force: true }); });
  const policy = { mode: 'workspace-write', workspaceRoot: root, sessionId: 'queue' };
  const first = context.sandbox.confine(['pwsh.exe'], policy, active.signal);
  const firstCancelled = assert.rejects(first, error => error.name === 'AbortError');
  let firstSettled = false; first.catch(() => { firstSettled = true; });
  const second = context.sandbox.confine(['pwsh.exe'], policy, queued.signal);
  const secondCancelled = assert.rejects(second, error => error.name === 'AbortError');
  await delay(100); queued.abort(); await secondCancelled;
  assert.equal(firstSettled, false, 'cancelling a queued call must not retire the active native preparation');
  const readOnly = await Promise.race([
    context.sandbox.confine(['pwsh.exe'], { ...policy, mode: 'read-only' }),
    delay(2000).then(() => { throw new Error('read-only access waited behind write preparation'); }),
  ]);
  assert.notDeepEqual(readOnly.argv, ['pwsh.exe']);
  active.abort(); await firstCancelled;
});

test('idle preparation processes are recycled when opening more workspaces than the process limit', {
  skip: process.platform !== 'win32', timeout: 15000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-sandbox-capacity-'));
  const context = new Context(); const plugin = context.plugin(WindowsSandboxProvider, {}); await plugin;
  t.after(async () => { await plugin.dispose(); await rm(root, { recursive: true, force: true }); });
  for (let index = 0; index < 6; index++) {
    const workspaceRoot = join(root, String(index)); await mkdir(workspaceRoot);
    const result = await context.sandbox.confine(['pwsh.exe'], { mode: 'read-only', workspaceRoot, sessionId: 'capacity' });
    assert.notDeepEqual(result.argv, ['pwsh.exe']);
  }
});

test('abrupt host exit also terminates its sandbox preparation process', {
  skip: process.platform !== 'win32', timeout: 15000,
}, async t => {
  const owner = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/windows-sandbox-owner.mjs', import.meta.url))], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  t.after(async () => {
    if (owner.exitCode === null && owner.signalCode === null) { const exit = once(owner, 'exit'); owner.kill(); await exit; }
  });
  const [{ helperPid }] = await once(owner, 'message');
  assert.doesNotThrow(() => process.kill(helperPid, 0));
  const exit = once(owner, 'exit'); owner.kill(); await exit;
  const alive = () => { try { process.kill(helperPid, 0); return true; } catch { return false; } };
  const deadline = performance.now() + 2000;
  while (alive() && performance.now() < deadline) await delay(20);
  assert.equal(alive(), false, 'native preparation must not outlive its host');
});

test('replacing a workspace discards both native grants and label observations before retry', {
  skip: process.platform !== 'win32', timeout: 15000,
}, async t => {
  const base = await mkdtemp(join(tmpdir(), 'codebuddy-sandbox-replaced-'));
  const root = join(base, 'work'); await mkdir(root);
  const context = new Context(); const plugin = context.plugin(WindowsSandboxProvider, {}); await plugin;
  t.after(async () => { await plugin.dispose(); await rm(base, { recursive: true, force: true }); });
  const policy = { mode: 'workspace-write', workspaceRoot: root, sessionId: 'replaced' };
  await context.sandbox.confine(['pwsh.exe'], policy);
  await rename(root, join(base, 'previous')); await mkdir(root);
  await assert.rejects(context.sandbox.confine(['pwsh.exe'], policy),
    error => error.code === 'SANDBOX_UNAVAILABLE' && /identity changed/.test(error.message));
  const recovered = await context.sandbox.confine(['pwsh.exe'], policy);
  assert.notDeepEqual(recovered.argv, ['pwsh.exe']);
});
