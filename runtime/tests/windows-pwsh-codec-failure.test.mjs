import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import '../harness/index.mjs';

const require = createRequire(new URL('../harness/package.json', import.meta.url));
const sdk = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)));
const { Context } = await sdk('cordis');
const { classifyRunnerFailure } = await sdk('dsh-sandbox');
const { default: SessionProjections } = await sdk('dsh-session-projection');
const { default: SandboxPolicy } = await sdk('dsh-sandbox-policy');
const { LocalJobRegistry } = await sdk('dsh-jobs-local');
const { default: WindowsSandboxProvider } = await import('../harness/windows-sandbox.mjs');
const { default: WindowsSubprocessRuntime } = await import('../harness/windows-shell-output.mjs');
const { default: CodeBuddyPwshExecutor } = await import('../harness/pwsh-executor.mjs');
const { pwshCodec } = await import('../harness/windows-pwsh-codec.mjs');
const { createHarnessDriver } = await import('../harness/index.mjs');
const windows = { skip: process.platform !== 'win32', timeout: 15000 };
const versionProbe = 'Write-Output $PSVersionTable.PSVersion.Major';

async function driverFixture(t) {
  const directory = await mkdtempDisposable(join(tmpdir(), 'codebuddy-codec-driver-'));
  let driver;
  t.after(async () => {
    try { await driver?.close(); } finally { await directory.remove(); }
  });
  const root = directory.path;
  driver = await createHarnessDriver({ dataDir: join(root, 'data'), cwd: root, instructionsHome: root });
  const session = await driver.createSession({
    cwd: root, provider: { id: 'offline', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '' }, model: 'offline',
  });
  await driver.permissions(session.sessionId, { preset: 'read-only' });
  return (args, signal) => driver.callTool(session.sessionId, 'pwsh', {
    command: 'Write-Output USER_PAYLOAD', description: 'Check PowerShell preparation outcome', ...args,
  }, { signal, onPermission: () => false });
}

async function fixture(t) {
  const directory = await mkdtempDisposable(join(tmpdir(), 'codebuddy-codec-failure-'));
  const root = directory.path;
  const ctx = new Context();
  t.after(async () => {
    try { await ctx.fiber.dispose(); } finally { await directory.remove(); }
  });
  const shell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const policy = { mode: 'read-only', workspaceRoot: root };
  await ctx.plugin(SessionProjections);
  await ctx.plugin(SandboxPolicy, policy);
  await ctx.plugin(WindowsSubprocessRuntime);
  await ctx.plugin(WindowsSandboxProvider, {});
  await ctx.plugin(CodeBuddyPwshExecutor, { cwd: root, pwshPath: shell, timeoutMs: 10000 });
  const execute = signal => ctx.shell.execute(ctx.shell.resolve({ command: 'Write-Output USER_PAYLOAD', signal }));
  return { ctx, root, shell, policy, execute };
}

test('a failed codec preload returns the native runner failure before a writable user command runs', windows, async t => {
  const { ctx, root, shell } = await fixture(t);
  const argv = [shell, '-NoLogo', '-NoProfile', '-Command', "Set-Content -LiteralPath 'user-started.txt' -Value started"];
  argv[pwshCodec] = 'legacy';
  const confined = await ctx.sandbox.confine(argv, { mode: 'workspace-write', workspaceRoot: root, sessionId: 'preload' });
  // Deliberately present a real NUL handle. The private-console handoff must
  // reject it, and its rejection must use the upstream runner failure contract.
  const signal = AbortSignal.timeout(6000);
  const handle = ctx.subprocess.spawn({ argv: confined.argv, cwd: root, signal, graceMs: 100,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 8192 } } });
  const { exitCode } = await handle.done;
  assert.equal(await handle.waitForExit(signal), true);
  const failure = classifyRunnerFailure(exitCode, handle.collected.stderr.readFrom(0).text, confined.runnerFailureRules);
  assert.match(failure?.detail ?? '', /redirected/i);
  await assert.rejects(access(join(root, 'user-started.txt')), { code: 'ENOENT' });
});

test('native sandbox unavailability during the version probe remains a structured tool failure', windows, async t => {
  const { ctx, execute } = await fixture(t);
  await ctx.sandbox.closePreparation();
  await assert.rejects(execute(), { name: 'SandboxUnavailableError', code: 'SANDBOX_UNAVAILABLE' });
});

test('default pwsh tool preserves structured sandbox unavailability before dispatch', windows, async t => {
  const execute = await driverFixture(t);
  const original = WindowsSandboxProvider.prototype.confine;
  const confine = t.mock.method(WindowsSandboxProvider.prototype, 'confine', function (argv, ...args) {
    if (argv.at(-1) === versionProbe) throw Error('Version probe unavailable in fixture');
    return original.call(this, argv, ...args);
  });
  const result = await execute();
  assert.equal(confine.mock.callCount(), 1);
  assert.equal(result.isError, true);
  assert.equal(result.error?.info?.code, 'SANDBOX_UNAVAILABLE');
  assert.match(result.error.message, /requested command was not started/);
});

test('a confinement reply delivered after the version deadline cannot launch even the probe', windows, async t => {
  const { ctx, shell, policy, execute } = await fixture(t);
  await ctx.sandbox.confine([shell], policy);
  const worker = [...ctx.sandbox.slots.values()][0].worker;
  const emit = worker.child.emit;
  let held = false;
  t.mock.method(worker.child, 'emit', function (event, ...args) {
    if (event === 'message' && args[0]?.result && !held) {
      held = true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5100);
    }
    return emit.call(this, event, ...args);
  });
  const spawn = t.mock.method(WindowsSubprocessRuntime.prototype, 'spawn');
  await assert.rejects(execute(), { code: 'SANDBOX_UNAVAILABLE' });
  assert.equal(held, true);
  assert.equal(spawn.mock.callCount(), 0);
});

test('cancelling a launched version probe drains its real process range without spawning the payload', windows, async t => {
  const { execute } = await fixture(t);
  const stop = new AbortController();
  const original = WindowsSubprocessRuntime.prototype.spawn;
  let probe, drained = false;
  const spawn = t.mock.method(WindowsSubprocessRuntime.prototype, 'spawn', function (spec) {
    const handle = original.call(this, spec);
    if (!probe) {
      probe = handle;
      void handle.waitForExit().then(value => { drained = value; }, () => {});
      setImmediate(() => stop.abort());
    }
    return handle;
  });
  await assert.rejects(execute(stop.signal), { name: 'AbortError' });
  assert.ok(probe);
  assert.equal(drained, true, 'The shell cancellation must join native Job range exit');
  assert.equal(spawn.mock.callCount(), 1);
});

test('a short native tool stop wait cannot abandon a running PowerShell version probe', windows, async t => {
  const execute = await driverFixture(t);
  const stop = new AbortController();
  const original = WindowsSubprocessRuntime.prototype.spawn;
  const wait = LocalJobRegistry.prototype.wait;
  let stopWaits = 0;
  t.mock.method(LocalJobRegistry.prototype, 'wait', function (id, timeoutMs, owner, signal) {
    // Shorten only the native post-cancellation wait, after a real probe has
    // launched. This keeps machine startup latency outside the assertion.
    if (signal) return wait.call(this, id, timeoutMs, owner, signal);
    stopWaits++;
    return wait.call(this, id, 1, owner);
  });
  let probe, drained = false;
  const spawn = t.mock.method(WindowsSubprocessRuntime.prototype, 'spawn', function (spec) {
    const handle = original.call(this, spec);
    if (spec.argv.at(-1) === versionProbe) {
      probe = handle;
      void handle.waitForExit().then(value => { drained = value; }, () => {});
      setImmediate(() => stop.abort());
    }
    return handle;
  });
  const result = await execute({ timeoutMs: 4000 }, stop.signal);
  assert.ok(probe, 'The real restricted probe must reach the native process owner');
  assert.equal(spawn.mock.callCount(), 1, 'No user payload may start after cancellation');
  assert.equal(stopWaits, 1);
  assert.equal(result.error?.info?.code, 'ABORTED');
  assert.equal(drained, true, 'The tool receipt must follow the real native Job range exit');
});
