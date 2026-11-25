import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile, link, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHarnessDriver } from '../harness/index.mjs';

test('an owner with Modify can use the Windows sandbox without widening other directories', { skip: process.platform !== 'win32' }, async t => {
  const base = await mkdtemp(join(tmpdir(), 'codebuddy-label-'));
  let holder;
  t.after(async () => {
    if (holder && holder.exitCode === null && holder.signalCode === null) {
      const exited = once(holder, 'exit');
      holder.kill();
      await exited;
    }
    await rm(base, { recursive: true, force: true });
  });
  const root = join(base, 'work'), child = join(root, 'existing'), sibling = join(base, 'sibling');
  await mkdir(child, { recursive: true });
  await mkdir(sibling);
  await writeFile(join(child, 'server.pid'), 'HOST_CREATED');
  const helper = fileURLToPath(new URL('../harness/WorkspaceLabelAccess.cs', import.meta.url));
  function ps(script, directory) {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop';" + script],
      { windowsHide: true, encoding: 'utf8', env: { ...process.env,
        PSModulePath: join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules'), CB_DIR: directory, CB_HELPER: helper } }).trim();
  }
  const sid = ps('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value', root);
  const icacls = (...args) => execFileSync('icacls.exe', args, { windowsHide: true });
  icacls(root, '/grant:r', '*' + sid + ':(OI)(CI)(M)');
  icacls(root, '/inheritance:r');
  const descriptor = p => ps('(Get-Acl -LiteralPath $env:CB_DIR).Sddl', p);
  const prepare = p => ps('Add-Type -Path $env:CB_HELPER; [WorkspaceLabelAccess]::Prepare($env:CB_DIR)', p);
  const parentBefore = descriptor(base), childBefore = descriptor(child);
  icacls(root, '/deny', '*' + sid + ':(WO)');
  const denied = descriptor(root);
  assert.equal(prepare(root), 'False');
  assert.equal(descriptor(root), denied);
  icacls(root, '/remove:d', '*' + sid);
  assert.equal(prepare(root), 'True');
  assert.equal(descriptor(child), childBefore, 'the root WRITE_OWNER repair must not edit existing children');
  assert.equal(descriptor(base), parentBefore);

  // Real desktop sessions keep a process cwd on the workspace. This denies DELETE
  // sharing even though the owner can still write files and change the root DACL.
  holder = spawn(process.execPath, ['-e', 'console.log("ready");setInterval(()=>{},1000)'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  await once(holder.stdout, 'data');
  const driver = await createHarnessDriver({ dataDir: join(base, 'harness'), cwd: root });
  try {
    const session = await driver.createSession({ cwd: root, provider: { id: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture' }, model: 'fixture', options: {} });
    const call = command => driver.callTool(session.sessionId, 'pwsh', { command, description: 'Check restricted workspace writes' }, { onPermission: () => true });
    const wrote = await call("Set-Content -LiteralPath 'inside.txt' -Value 'inside'");
    assert.equal(wrote.isError, false, JSON.stringify(wrote));
    assert.equal((await readFile(join(root, 'inside.txt'), 'utf8')).trim(), 'inside');
    const existing = await call("[IO.File]::WriteAllText((Join-Path $PWD 'existing/server.pid'), 'updated')");
    assert.equal(existing.value.exitCode, 0, JSON.stringify(existing));
    assert.equal(await readFile(join(child, 'server.pid'), 'utf8'), 'updated');
    const hostCreated = join(child, 'host-created.txt');
    const hostWrite = await driver.callTool(session.sessionId, 'write', { file_path: hostCreated, content: 'host' }, { onPermission: () => true });
    assert.equal(hostWrite.isError, false, JSON.stringify(hostWrite));
    const afterHostWrite = await call("[IO.File]::WriteAllText((Join-Path $PWD 'existing/host-created.txt'), 'restricted')");
    assert.equal(afterHostWrite.value.exitCode, 0, JSON.stringify(afterHostWrite));
    assert.equal(await readFile(hostCreated, 'utf8'), 'restricted');
    const escape = join(sibling, 'outside.txt');
    await call("Set-Content -LiteralPath '" + escape.replaceAll("'", "''") + "' -Value 'escaped'");
    await assert.rejects(readFile(escape), { code: 'ENOENT' });
  } finally { await driver.close(); }
  const prepared = descriptor(root);
  assert.equal(prepare(root), 'True');
  assert.equal(descriptor(root), prepared);
  assert.equal(descriptor(base), parentBefore);
  // Native sandbox capability inheritance is separate from the root repair.
  // It must not turn an ordinary inheriting directory into a protected DACL.
  assert.equal(ps('(Get-Acl -LiteralPath $env:CB_DIR).AreAccessRulesProtected', child), 'False');
  assert.match(descriptor(root), new RegExp('\\(A;;WO;;;' + sid + '\\)'));
  assert.ok(!descriptor(child).includes('(A;;WO;;;' + sid + ')'));
  assert.ok(!childBefore.includes('(A;;WO;;;' + sid + ')'));
});

test('existing-file labels preserve DACLs and skip protected items, junctions and outside hard links', { skip: process.platform !== 'win32' }, async t => {
  const base = await mkdtemp(join(tmpdir(), 'codebuddy-label-boundary-'));
  const root = join(base, 'work'), outside = join(base, 'outside');
  await mkdir(root); await mkdir(outside);
  const allowed = join(root, 'allowed.txt'), protectedFile = join(root, 'protected.txt');
  const explicitLabel = join(root, 'medium.txt'), outsideFile = join(outside, 'outside.txt');
  for (const file of [allowed, protectedFile, explicitLabel, outsideFile]) await writeFile(file, 'original');
  await link(outsideFile, join(root, 'alias.txt'));
  const junction = join(root, 'junction');
  await symlink(outside, junction, 'junction');
  t.after(async () => {
    // Remove only the QA junction itself before recursive fixture cleanup.
    await rm(junction); await rm(base, { recursive: true, force: true });
  });
  const helper = fileURLToPath(new URL('../harness/WorkspaceLabelAccess.cs', import.meta.url));
  const script = `
    $ErrorActionPreference='Stop'
    Add-Type -Path $env:CB_HELPER
    $allowed=Join-Path $env:CB_ROOT 'allowed.txt'
    $protected=Join-Path $env:CB_ROOT 'protected.txt'
    $medium=Join-Path $env:CB_ROOT 'medium.txt'
    $a=Get-Acl -LiteralPath $protected; $a.SetAccessRuleProtection($true,$true); Set-Acl -LiteralPath $protected -AclObject $a
    & icacls.exe $medium /setintegritylevel M | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Fixture label setup failed' }
    $before=@{}; foreach($p in @($allowed,$protected,$medium,$env:CB_OUTSIDE)) { $before[$p]=(Get-Acl -LiteralPath $p).Sddl }
    $count=[WorkspaceLabelAccess]::PrepareExisting($env:CB_ROOT)
    foreach($p in $before.Keys) { if((Get-Acl -LiteralPath $p).Sddl -ne $before[$p]) { throw "DACL changed: $p" } }
    $again=[WorkspaceLabelAccess]::PrepareExisting($env:CB_ROOT)
    [pscustomobject]@{changed=$count;again=$again;allowed=(& icacls.exe $allowed | Out-String);protected=(& icacls.exe $protected | Out-String);outside=(& icacls.exe $env:CB_OUTSIDE | Out-String);medium=(& icacls.exe $medium | Out-String)} | ConvertTo-Json -Compress
  `;
  const result = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, encoding: 'utf8', env: { ...process.env, CB_HELPER: helper, CB_ROOT: root, CB_OUTSIDE: outsideFile,
      PSModulePath: join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules') },
  }));
  assert.equal(result.changed, 1, JSON.stringify(result));
  assert.equal(result.again, 0);
  assert.equal(await readFile(outsideFile, 'utf8'), 'original');
});
