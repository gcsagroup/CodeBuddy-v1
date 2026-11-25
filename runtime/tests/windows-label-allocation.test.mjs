import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

test('an already-labelled traversal keeps managed allocation proportional to actual path lengths', {
  skip: process.platform !== 'win32', timeout: 25000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-label-allocation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (let i = 0; i < 500; i++) await writeFile(join(root, `${i}.txt`), 'fixture');
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference='Stop'
    Add-Type -Path $env:CB_HELPER
    [AppDomain]::MonitoringIsEnabled=$true
    $first=[WorkspaceLabelAccess]::PrepareExistingBounded($env:CB_ROOT,10000,'')
    [GC]::Collect()
    $before=[AppDomain]::CurrentDomain.MonitoringTotalAllocatedMemorySize
    $again=[WorkspaceLabelAccess]::PrepareExistingBounded($env:CB_ROOT,10000,'')
    [GC]::Collect()
    $bytes=[AppDomain]::CurrentDomain.MonitoringTotalAllocatedMemorySize-$before
    [pscustomobject]@{first=$first;again=$again;allocatedBytes=$bytes}|ConvertTo-Json -Depth 4 -Compress
  `], { windowsHide: true, timeout: 20000, maxBuffer: 16384, env: { ...process.env, CB_ROOT: root,
    CB_HELPER: fileURLToPath(new URL('../harness/WorkspaceLabelAccess.cs', import.meta.url)),
    PSModulePath: join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules') } });
  const result = JSON.parse(stdout);
  assert.equal(result.first.Status, 'complete');
  assert.equal(result.again.Status, 'complete');
  assert.equal(result.again.Visited, 501);
  assert.equal(result.again.Changed, 0);
  // The 32K-character allocation used over 64MB for these short paths. Leave
  // ample room for security descriptors and runtime overhead, not that buffer.
  assert.ok(result.allocatedBytes < 16 * 1024 * 1024, `Short-path traversal allocated ${result.allocatedBytes} bytes`);
  t.diagnostic(JSON.stringify({ visited: result.again.Visited, allocatedBytes: result.allocatedBytes }));
});

test('proportional path buffers retain long Unicode path checks and label preparation', {
  skip: process.platform !== 'win32', timeout: 20000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-label-long-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let directory = root, levels = 0;
  while (directory.length <= 280) { directory = join(directory, '路径'.repeat(32) + levels++); await mkdir(directory); }
  const file = join(directory, '中文🚀.txt'); await writeFile(file, 'fixture');
  assert.ok(file.length > 260);
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference='Stop';Add-Type -Path $env:CB_HELPER
    $prepared=[WorkspaceLabelAccess]::Prepare($env:CB_DEEP)
    $before=(Get-Acl -LiteralPath $env:CB_DEEP).Sddl
    $result=[WorkspaceLabelAccess]::PrepareExistingBounded($env:CB_ROOT,10000,'')
    $same=$before -eq (Get-Acl -LiteralPath $env:CB_DEEP).Sddl
    [pscustomobject]@{prepared=$prepared;result=$result;daclPreserved=$same}|ConvertTo-Json -Depth 4 -Compress
  `], { windowsHide: true, timeout: 15000, maxBuffer: 16384, env: { ...process.env, CB_ROOT: root, CB_DEEP: directory,
    CB_HELPER: fileURLToPath(new URL('../harness/WorkspaceLabelAccess.cs', import.meta.url)),
    PSModulePath: join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules') } });
  const value = JSON.parse(stdout);
  assert.equal(value.prepared, true);
  assert.equal(value.result.Status, 'complete');
  assert.equal(value.result.Visited, levels + 2);
  assert.equal(value.result.Changed, levels + 1);
  assert.equal(value.daclPreserved, true);
});
