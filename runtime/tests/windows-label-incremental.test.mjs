import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, link, symlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import '../harness/index.mjs';

const { default: NativeWindowsSandboxProvider } = await import('../harness/windows-sandbox-native.mjs');

const run = promisify(execFile);
const require = createRequire(new URL('../harness/package.json', import.meta.url));
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
const ps = (script, env = {}) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop';" + script],
  { windowsHide: true, timeout: 30000, env: { ...process.env, ...env,
    PSModulePath: join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules') } });

test('changed-path labels pin ancestors, preserve policy and never enumerate unrelated siblings', {
  skip: process.platform !== 'win32', timeout: 45000,
}, async t => {
  const base = await mkdtemp(join(tmpdir(), 'codebuddy-label-selection-'));
  const root = join(base, 'work'), outside = join(base, 'outside');
  await mkdir(join(root, 'nested'), { recursive: true }); await mkdir(outside);
  await mkdir(join(root, 'protected'));
  for (const path of ['nested/allowed.txt', 'nested/sibling.txt', 'protected/child.txt', 'medium.txt'])
    await writeFile(join(root, path), 'fixture');
  const outsideFile = join(outside, 'outside.txt'); await writeFile(outsideFile, 'outside');
  await link(outsideFile, join(root, 'alias.txt'));
  const junction = join(root, 'junction'); await symlink(outside, junction, 'junction');
  t.after(async () => { await rm(junction); await rm(base, { recursive: true, force: true }); });
  const { stdout } = await ps(`
    Add-Type -Path $env:CB_HELPER
    $protected=Join-Path $env:CB_ROOT 'protected'
    $a=Get-Acl -LiteralPath $protected; $a.SetAccessRuleProtection($true,$true); Set-Acl -LiteralPath $protected -AclObject $a
    & icacls.exe (Join-Path $env:CB_ROOT 'medium.txt') /setintegritylevel M | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Fixture setup failed' }
    $paths=[string[]]@('nested/allowed.txt','protected/child.txt','medium.txt','alias.txt','junction/outside.txt' | ForEach-Object { Join-Path $env:CB_ROOT $_ })
    $all=@($paths[0],(Join-Path $env:CB_ROOT 'nested'),$protected,$paths[1],$paths[2],$env:CB_OUTSIDE)
    $before=@{}; foreach($p in $all) { $before[$p]=(Get-Acl -LiteralPath $p).Sddl }
    $rejected=$false
    try { [void][WorkspaceLabelAccess]::PrepareChangedBounded($env:CB_ROOT, [string[]]@($paths[0],$env:CB_OUTSIDE), 5000, '') } catch { $rejected=$true }
    if (!$rejected) { throw 'Outside selection was accepted' }
    $result=[WorkspaceLabelAccess]::PrepareChangedBounded($env:CB_ROOT,$paths,5000,'')
    foreach($p in $before.Keys) { if ((Get-Acl -LiteralPath $p).Sddl -ne $before[$p]) { throw "DACL changed: $p" } }
    $again=[WorkspaceLabelAccess]::PrepareChangedBounded($env:CB_ROOT,$paths,5000,'')
    # Only the untouched ordinary sibling remains eligible in a full scan.
    $remaining=[WorkspaceLabelAccess]::PrepareExistingBounded($env:CB_ROOT,5000,'')
    [pscustomobject]@{result=$result;again=$again;remaining=$remaining} | ConvertTo-Json -Depth 4 -Compress
  `, { CB_ROOT: root, CB_OUTSIDE: outsideFile, CB_HELPER: fileURLToPath(new URL('../harness/WorkspaceLabelAccess.cs', import.meta.url)) });
  const result = JSON.parse(stdout);
  assert.equal(result.result.Status, 'complete');
  assert.equal(result.result.Changed, 2, JSON.stringify(result));
  assert.ok(result.result.Visited <= 9, JSON.stringify(result));
  assert.equal(result.again.Changed, 0);
  assert.equal(result.remaining.Changed, 1, 'the selected scan must leave unrelated siblings untouched');
});

test('a complete baseline is reused, new host and external files are repaired incrementally, and lost observation invalidates it', {
  skip: process.platform !== 'win32', timeout: 45000,
}, async t => {
  const base = await mkdtemp(join(tmpdir(), 'codebuddy-label-incremental-'));
  const root = join(base, 'work'); await mkdir(join(root, 'nested'), { recursive: true });
  await writeFile(join(root, 'nested/old.txt'), 'old');
  const { stdout } = await ps('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
  await run('icacls.exe', [root, '/grant:r', '*' + stdout.trim() + ':(OI)(CI)(M)'], { windowsHide: true });
  await run('icacls.exe', [root, '/inheritance:r'], { windowsHide: true });
  const context = new Context(); await context.plugin(NativeWindowsSandboxProvider, {});
  t.after(async () => { await context.fiber.dispose(); await rm(base, { recursive: true, force: true }); });
  const sandbox = context.sandbox, phases = [];
  sandbox.onPreparationPhase = phase => phases.push(phase);
  const policy = { mode: 'workspace-write', workspaceRoot: root, sessionId: 'incremental-fixture' };
  async function restrictedWrite(file) {
    sandbox.preparationDeadline = Date.now() + 30000;
    const confined = await sandbox.confine(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop';[IO.File]::WriteAllText($env:CB_FILE,'restricted-updated')"], policy);
    await run(confined.argv[0], confined.argv.slice(1), { cwd: root, windowsHide: true, timeout: 7000, env: { ...process.env, CB_FILE: file } });
  }
  await restrictedWrite(join(root, 'nested/old.txt'));
  await restrictedWrite(join(root, 'nested/old.txt'));
  assert.equal(phases.filter(phase => phase === 'existing-file-labels').length, 1);
  assert.ok(phases.includes('labels-current'));
  const hostFile = join(root, 'nested/host-created.txt'); await writeFile(hostFile, 'host');
  sandbox.noteFileMutation(hostFile);
  await restrictedWrite(hostFile);
  assert.ok(phases.includes('changed-file-labels'));
  assert.equal(phases.filter(phase => phase === 'existing-file-labels').length, 1);
  const external = join(root, 'nested/external.txt'); await writeFile(external, 'external');
  // External notifications are asynchronous; host tool writes use IPC instead.
  await delay(100);
  await restrictedWrite(external);
  assert.equal(phases.filter(phase => phase === 'existing-file-labels').length, 1);
  const state = [...sandbox.labelStates.values()][0];
  state.watcher.emit('change', 'change', null); // Native overflow has no filename.
  await restrictedWrite(external);
  assert.equal(phases.filter(phase => phase === 'existing-file-labels').length, 2);
  state.watcher.emit('error', new Error('Fixture observer lost'));
  await restrictedWrite(external);
  assert.equal(phases.filter(phase => phase === 'existing-file-labels').length, 3);
  await rename(root, join(base, 'previous')); await mkdir(root);
  await assert.rejects(sandbox.confine(['ignored'], policy), { code: 'CODEBUDDY_WORKSPACE_CHANGED' });
});
