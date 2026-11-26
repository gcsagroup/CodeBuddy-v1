import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import '../harness/index.mjs';

const { default: NativeWindowsSandboxProvider } = await import('../harness/windows-sandbox-native.mjs');
const run = promisify(execFile);
const require = createRequire(new URL('../harness/package.json', import.meta.url));
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
const ps = (script, env = {}) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop';" + script],
  { windowsHide: true, timeout: 30000, env: { ...process.env, ...env,
    PSModulePath: join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules') } });

test('read-only confinement bypasses label preparation and workspace replacement invalidates cached native grants', {
  skip: process.platform !== 'win32', timeout: 20000,
}, async t => {
  const base = await mkdtemp(join(tmpdir(), 'codebuddy-label-root-'));
  const root = join(base, 'work'); await mkdir(root);
  const context = new Context(); await context.plugin(NativeWindowsSandboxProvider, {});
  t.after(async () => { await context.fiber.dispose(); await rm(base, { recursive: true, force: true }); });
  const sandbox = context.sandbox;
  const check = t.mock.method(sandbox, 'runLabelPreparation', () => { throw Error('Read-only calls must not prepare workspace labels'); });
  await sandbox.confine(['pwsh.exe'], { mode: 'read-only', workspaceRoot: root });
  assert.equal(check.mock.callCount(), 0);
  check.mock.restore();
  sandbox.preparationDeadline = Date.now() + 15000;
  const policy = { mode: 'workspace-write', workspaceRoot: root, sessionId: 'identity' };
  await sandbox.confine(['pwsh.exe'], policy);
  await rename(root, join(base, 'previous')); await mkdir(root);
  await assert.rejects(sandbox.confine(['pwsh.exe'], policy), { code: 'CODEBUDDY_WORKSPACE_CHANGED' });
});

test('a temporary sharing conflict skips its Unicode target without blocking unrelated commands and repairs on the next full check', {
  skip: process.platform !== 'win32', timeout: 30000,
}, async t => {
  const base = await mkdtemp(join(tmpdir(), 'codebuddy-label-sharing-'));
  const root = join(base, 'work'); await mkdir(join(root, 'nested'), { recursive: true });
  await writeFile(join(root, 'nested/old.txt'), 'old');
  const { stdout } = await ps('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
  await run('icacls.exe', [root, '/grant:r', '*' + stdout.trim() + ':(OI)(CI)(M)'], { windowsHide: true });
  await run('icacls.exe', [root, '/inheritance:r'], { windowsHide: true });
  const context = new Context(); await context.plugin(NativeWindowsSandboxProvider, {});
  let holder, finished;
  const release = async () => {
    if (holder?.exitCode === null && holder.signalCode === null) { holder.stdin.end('\n'); await finished; }
  };
  t.after(async () => { await release(); await context.fiber.dispose(); await rm(base, { recursive: true, force: true }); });
  const sandbox = context.sandbox, phases = [];
  sandbox.onPreparationPhase = phase => phases.push(phase);
  const policy = { mode: 'workspace-write', workspaceRoot: root, sessionId: 'sharing-fixture' };
  const confine = (command = "$ErrorActionPreference='Stop';[IO.File]::WriteAllText($env:CB_FILE,'after-unlock')") => {
    sandbox.preparationDeadline = Date.now() + 20000;
    return sandbox.confine(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
      command], policy);
  };
  await confine();
  const file = join(root, 'nested/' + '中文'.repeat(30) + '🚀.txt'); await writeFile(file, 'before');
  holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$f=[IO.File]::Open($env:CB_FILE,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read);[Console]::WriteLine('HELD');[void][Console]::ReadLine();$f.Dispose()"],
  { windowsHide: true, env: { ...process.env, CB_FILE: file }, stdio: ['pipe', 'pipe', 'pipe'] });
  finished = once(holder, 'exit');
  const [ready] = await once(holder.stdout, 'data'); assert.match(ready.toString(), /HELD/);
  const locked = await confine('Write-Output UNRELATED_OK');
  const unrelated = await run(locked.argv[0], locked.argv.slice(1), { cwd: root, windowsHide: true, timeout: 7000 });
  assert.match(unrelated.stdout, /UNRELATED_OK/);
  assert.ok(phases.includes('labels-deferred'));
  await release();
  const recovered = await confine();
  await run(recovered.argv[0], recovered.argv.slice(1), {
    cwd: root, windowsHide: true, timeout: 7000, env: { ...process.env, CB_FILE: file },
  });
  assert.equal(phases.filter(phase => phase === 'existing-file-labels').length, 3);
});

test('many locked Unicode files do not block unrelated commands and are rechecked after unlock', {
  skip: process.platform !== 'win32', timeout: 30000,
}, async t => {
  const base = await mkdtemp(join(tmpdir(), 'codebuddy-label-overflow-'));
  const root = join(base, 'work'); await mkdir(join(root, 'nested'), { recursive: true });
  const { stdout } = await ps('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
  await run('icacls.exe', [root, '/grant:r', '*' + stdout.trim() + ':(OI)(CI)(M)'], { windowsHide: true });
  await run('icacls.exe', [root, '/inheritance:r'], { windowsHide: true });
  const context = new Context(); await context.plugin(NativeWindowsSandboxProvider, {});
  const sandbox = context.sandbox, phases = [];
  sandbox.onPreparationPhase = phase => phases.push(phase);
  let holder, finished;
  const release = async () => {
    if (holder?.exitCode === null && holder.signalCode === null) { holder.stdin.end('\n'); await finished; }
  };
  t.after(async () => { await release(); await context.fiber.dispose(); await rm(base, { recursive: true, force: true }); });
  const policy = { mode: 'workspace-write', workspaceRoot: root, sessionId: 'overflow-fixture' };
  async function confine(command) {
    sandbox.preparationDeadline = Date.now() + 20000;
    return sandbox.confine(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command], policy);
  }
  await confine('Write-Output READY');
  const paths = Array.from({ length: 40 }, (_, i) => join(root, 'nested', i + '中文'.repeat(30) + '🚀.txt'));
  for (const file of paths) { await writeFile(file, 'before'); }
  const list = join(base, 'paths.json'); await writeFile(list, JSON.stringify(paths));
  holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$paths=Get-Content -LiteralPath $env:CB_PATHS -Raw -Encoding UTF8|ConvertFrom-Json;$held=@();foreach($p in $paths){$held+=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read)};[Console]::WriteLine('HELD');[void][Console]::ReadLine();foreach($f in $held){$f.Dispose()}"],
  { windowsHide: true, env: { ...process.env, CB_PATHS: list }, stdio: ['pipe', 'pipe', 'pipe'] });
  finished = once(holder, 'exit');
  const [ready] = await once(holder.stdout, 'data'); assert.match(ready.toString(), /HELD/);
  const locked = await confine('Write-Output UNRELATED_OK');
  const result = await run(locked.argv[0], locked.argv.slice(1), { cwd: root, windowsHide: true, timeout: 7000 });
  assert.match(result.stdout, /UNRELATED_OK/);
  assert.ok(phases.includes('labels-deferred'));
  await release();
  const recovered = await confine("$ErrorActionPreference='Stop';[IO.File]::WriteAllText($env:CB_FILE,'after-unlock')");
  await run(recovered.argv[0], recovered.argv.slice(1), { cwd: root, windowsHide: true, timeout: 7000, env: { ...process.env, CB_FILE: paths.at(-1) } });
  assert.equal(phases.filter(phase => phase === 'existing-file-labels').length, 3);
});
