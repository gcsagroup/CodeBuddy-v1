import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
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

test('security-only initial preparation completes one baseline and subsequent calls do not rescan it', {
  skip: process.platform !== 'win32' || process.arch !== 'x64', timeout: 30000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-label-security-events-'));
  for (let n = 0; n < 4000; n++) await writeFile(join(root, `existing-${n}.txt`), 'fixture');
  const { stdout } = await ps('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
  await run('icacls.exe', [root, '/grant:r', '*' + stdout.trim() + ':(OI)(CI)(M)'], { windowsHide: true });
  await run('icacls.exe', [root, '/inheritance:r'], { windowsHide: true });
  const context = new Context(); await context.plugin(NativeWindowsSandboxProvider, {});
  t.after(async () => { await context.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  const sandbox = context.sandbox, phases = [];
  sandbox.onPreparationPhase = phase => phases.push(phase);
  const policy = { mode: 'workspace-write', workspaceRoot: root, sessionId: 'security-only' };
  sandbox.preparationDeadline = Date.now() + 25000;
  await sandbox.confine(['pwsh.exe'], policy);
  assert.equal(phases.filter(phase => phase === 'existing-file-labels').length, 1,
    'own label security writes must not invalidate a completed namespace baseline');
  await sandbox.confine(['pwsh.exe'], policy);
  assert.equal(phases.filter(phase => phase === 'existing-file-labels').length, 1);
  assert.ok(phases.includes('labels-current'));
});
const ps = (script, env = {}) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop';" + script],
  { windowsHide: true, timeout: 30000, env: { ...process.env, ...env,
    PSModulePath: join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules') } });

test('observation lost during an incremental pass repairs unseen files before returning the same command', {
  skip: process.platform !== 'win32' || process.arch !== 'x64', timeout: 20000,
}, async t => {
  const base = await mkdtemp(join(tmpdir(), 'codebuddy-label-observer-loss-'));
  const root = join(base, 'work'), incoming = join(base, 'incoming.txt');
  await mkdir(root); await writeFile(incoming, 'created before workspace initialization');
  const { stdout } = await ps('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
  await run('icacls.exe', [root, '/grant:r', '*' + stdout.trim() + ':(OI)(CI)(M)'], { windowsHide: true });
  await run('icacls.exe', [root, '/inheritance:r'], { windowsHide: true });
  const context = new Context(); await context.plugin(NativeWindowsSandboxProvider, {});
  t.after(async () => { await context.fiber.dispose(); await rm(base, { recursive: true, force: true }); });
  const sandbox = context.sandbox;
  const policy = { mode: 'workspace-write', workspaceRoot: root, sessionId: 'observer-loss' };
  sandbox.preparationDeadline = Date.now() + 15000;
  await sandbox.confine(['pwsh.exe'], policy);
  const known = join(root, 'known.txt'), unseen = join(root, 'unseen.txt');
  await writeFile(known, 'known'); sandbox.noteFileMutation(known);
  const state = [...sandbox.labelStates.values()][0], original = sandbox.runLabelPreparation.bind(sandbox), passes = [];
  t.mock.method(sandbox, 'runLabelPreparation', async (root, paths, signal) => {
    passes.push(paths ? 'incremental' : 'full');
    if (passes.length === 1) {
      assert.ok(paths, 'the fixture must enter a real incremental pass');
      await state.watcher.close();
      await rename(incoming, unseen);
      // A same-volume move retains its former DACL. Give this eligible fixture
      // the existing workspace inheritance, isolating the missing label repair
      // from the independent upstream grant-refresh limitation.
      await run('icacls.exe', [unseen, '/reset'], { windowsHide: true });
    }
    return original(root, paths, signal);
  });
  const confined = await sandbox.confine([process.execPath, '-e',
    "require('node:fs').writeFileSync(process.argv[1],'updated');console.log('REPAIRED')", unseen], policy);
  const result = await run(confined.argv[0], confined.argv.slice(1), { cwd: root, windowsHide: true, timeout: 5000 });
  assert.match(result.stdout, /REPAIRED/);
  assert.deepEqual(passes, ['incremental', 'full']);
});

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
  // Hold this JS process while a real external burst exceeds the 64KiB native
  // notification buffer. No fabricated EventEmitter overflow or filename.
  execFileSync(process.execPath, ['-e', `const fs=require('node:fs'),p=require('node:path');
    for(let n=0;n<1200;n++)fs.writeFileSync(p.join(process.argv[1],'external-burst-'+n+'-'.repeat(48)+'.txt'),'fixture');`, root],
  { windowsHide: true, timeout: 7000 });
  await restrictedWrite(external);
  assert.equal(phases.filter(phase => phase === 'existing-file-labels').length, 2);
  await state.watcher.close();
  await restrictedWrite(external);
  assert.equal(phases.filter(phase => phase === 'existing-file-labels').length, 3);
  await rename(root, join(base, 'previous')); await mkdir(root);
  await assert.rejects(sandbox.confine(['ignored'], policy), { code: 'CODEBUDDY_WORKSPACE_CHANGED' });
});

test('a temporary sharing conflict defers its Unicode target without blocking unrelated commands and repairs after unlock', {
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
  sandbox.noteFileMutation(file);
  holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$f=[IO.File]::Open($env:CB_FILE,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read);[Console]::WriteLine('HELD');[void][Console]::ReadLine();$f.Dispose()"],
  { windowsHide: true, env: { ...process.env, CB_FILE: file }, stdio: ['pipe', 'pipe', 'pipe'] });
  finished = once(holder, 'exit');
  const [ready] = await once(holder.stdout, 'data'); assert.match(ready.toString(), /HELD/);
  const locked = await confine('Write-Output UNRELATED_OK');
  const unrelated = await run(locked.argv[0], locked.argv.slice(1), { cwd: root, windowsHide: true, timeout: 7000 });
  assert.match(unrelated.stdout, /UNRELATED_OK/);
  assert.ok([...sandbox.labelStates.values()][0].deferred.has(file), 'the exact Unicode target must remain pending');
  await release();
  const recovered = await confine();
  await run(recovered.argv[0], recovered.argv.slice(1), {
    cwd: root, windowsHide: true, timeout: 7000, env: { ...process.env, CB_FILE: file },
  });
  assert.equal([...sandbox.labelStates.values()][0].deferred.size, 0);
  assert.equal(phases.filter(phase => phase === 'existing-file-labels').length, 1, 'a deferred target must not force repeated whole-tree checks');
});

test('deferred Unicode paths stay bounded and overflow falls back on the next call without blocking this command', {
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
  for (const file of paths) { await writeFile(file, 'before'); sandbox.noteFileMutation(file); }
  const list = join(base, 'paths.json'); await writeFile(list, JSON.stringify(paths));
  holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$paths=Get-Content -LiteralPath $env:CB_PATHS -Raw -Encoding UTF8|ConvertFrom-Json;$held=@();foreach($p in $paths){$held+=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read)};[Console]::WriteLine('HELD');[void][Console]::ReadLine();foreach($f in $held){$f.Dispose()}"],
  { windowsHide: true, env: { ...process.env, CB_PATHS: list }, stdio: ['pipe', 'pipe', 'pipe'] });
  finished = once(holder, 'exit');
  const [ready] = await once(holder.stdout, 'data'); assert.match(ready.toString(), /HELD/);
  const locked = await confine('Write-Output UNRELATED_OK');
  const result = await run(locked.argv[0], locked.argv.slice(1), { cwd: root, windowsHide: true, timeout: 7000 });
  assert.match(result.stdout, /UNRELATED_OK/);
  const state = [...sandbox.labelStates.values()][0];
  assert.equal(state.hasBaseline, false, 'overflow must invalidate the next full-check baseline');
  assert.ok(state.deferred.size > 0 && state.deferred.size <= 64);
  assert.ok([...state.deferred].every(path => paths.includes(path)), 'deferred filenames must remain exact Unicode strings');
  assert.ok([...state.deferred].reduce((total, path) => total + path.length, 0) <= 4096);
  assert.equal(phases.filter(phase => phase === 'existing-file-labels').length, 1, 'overflow must not spin on a full scan in this invocation');
  await release();
  const recovered = await confine("$ErrorActionPreference='Stop';[IO.File]::WriteAllText($env:CB_FILE,'after-unlock')");
  await run(recovered.argv[0], recovered.argv.slice(1), { cwd: root, windowsHide: true, timeout: 7000, env: { ...process.env, CB_FILE: paths.at(-1) } });
  assert.equal(state.deferred.size, 0);
  assert.equal(state.hasBaseline, true);
  assert.ok(phases.filter(phase => phase === 'existing-file-labels').length >= 2,
    'the next invocation must reestablish a full baseline; native notification loss can require an additional check');
});
