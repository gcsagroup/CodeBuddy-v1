import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

test('label preparation returns at safe object boundaries on cancellation or deadline and can run again', {
  skip: process.platform !== 'win32', timeout: 45000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-label-deadline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(project);
  await Promise.all(Array.from({ length: 500 }, (_, i) => writeFile(join(project, `${i}.txt`), 'fixture')));
  const cancelFile = join(root, 'cancel'); await writeFile(cancelFile, '');
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference='Stop'
    Add-Type -Path $env:CB_HELPER
    $sample=Get-ChildItem -LiteralPath $env:CB_ROOT -File | Select-Object -First 20
    $before=@{}; foreach($p in $sample) { $before[$p.FullName]=(Get-Acl -LiteralPath $p.FullName).Sddl }
    $cancelled=[WorkspaceLabelAccess]::PrepareExistingBounded($env:CB_ROOT, 5000, $env:CB_CANCEL)
    Remove-Item -LiteralPath $env:CB_CANCEL
    $expired=[WorkspaceLabelAccess]::PrepareExistingBounded($env:CB_ROOT, 10, $env:CB_CANCEL)
    foreach($p in $before.Keys) { if ((Get-Acl -LiteralPath $p).Sddl -ne $before[$p]) { throw "Temporary DACL was not restored: $p" } }
    $recovered=[WorkspaceLabelAccess]::PrepareExistingBounded($env:CB_ROOT, 15000, $env:CB_CANCEL)
    foreach($p in $before.Keys) { if ((Get-Acl -LiteralPath $p).Sddl -ne $before[$p]) { throw "DACL changed after recovery: $p" } }
    [pscustomobject]@{cancelled=$cancelled;expired=$expired;recovered=$recovered} | ConvertTo-Json -Depth 4 -Compress
  `], { windowsHide: true, encoding: 'utf8', timeout: 35000,
    env: { ...process.env, CB_ROOT: project, CB_CANCEL: cancelFile,
      CB_HELPER: fileURLToPath(new URL('../harness/WorkspaceLabelAccess.cs', import.meta.url)),
      PSModulePath: join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules') } });
  const result = JSON.parse(stdout);
  assert.equal(result.cancelled.Status, 'cancelled');
  assert.equal(result.cancelled.Changed, 0);
  assert.equal(result.expired.Status, 'deadline');
  assert.ok(result.expired.Visited < 501, JSON.stringify(result.expired));
  assert.equal(result.recovered.Status, 'complete');
  assert.ok(result.recovered.Changed > 0, JSON.stringify(result));
});
