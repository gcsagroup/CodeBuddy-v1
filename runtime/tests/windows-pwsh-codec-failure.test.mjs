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
const { default: WindowsSandboxProvider } = await import('../harness/windows-sandbox.mjs');
const { default: WindowsSubprocessRuntime } = await import('../harness/windows-shell-output.mjs');
const { default: CodeBuddyPwshExecutor } = await import('../harness/pwsh-executor.mjs');
const { pwshCodec } = await import('../harness/windows-pwsh-codec.mjs');
const windows = { skip: process.platform !== 'win32', timeout: 15000 };

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

test('a confinement reply delivered after the version deadline cannot launch even the probe', windows, async t => {
  const { ctx, shell, policy, execute } = await fixture(t);
  await ctx.sandbox.confine([shell], policy);
  const worker = [...ctx.sandbox.workers.values()][0];
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
  let probe;
  const spawn = t.mock.method(WindowsSubprocessRuntime.prototype, 'spawn', function (spec) {
    const handle = original.call(this, spec);
    if (!probe) {
      probe = handle;
      setImmediate(() => stop.abort());
    }
    return handle;
  });
  await assert.rejects(execute(stop.signal), { name: 'AbortError' });
  assert.ok(probe);
  assert.equal(await probe.waitForExit(AbortSignal.timeout(5000)), true);
  assert.equal(spawn.mock.callCount(), 1);
});
