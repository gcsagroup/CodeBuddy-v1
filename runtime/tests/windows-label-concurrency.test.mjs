import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

async function prepareWhileScanning(t, nested = false) {
  const base = await mkdtemp(join(tmpdir(), 'codebuddy-label-concurrency-'));
  const large = join(base, 'large'), files = nested ? join(large, 'nested') : large;
  const small = nested ? files : join(base, 'small'); await mkdir(files, { recursive: true });
  if (!nested) await mkdir(small);
  await writeFile(join(small, 'fallback.txt'), 'fixture');
  for (let offset = 0; offset < 10000; offset += 64)
    await Promise.all(Array.from({ length: Math.min(64, 10000 - offset) }, (_, i) => writeFile(join(files, `${offset + i}.txt`), '')));
  const env = { ...process.env, CB_HELPER: fileURLToPath(new URL('../harness/WorkspaceLabelAccess.cs', import.meta.url)),
    PSModulePath: join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules') };
  const scanner = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop';Add-Type -Path $env:CB_HELPER;[Console]::WriteLine('SCANNING');[WorkspaceLabelAccess]::PrepareExistingBounded($env:CB_ROOT,20000,'')|ConvertTo-Json -Compress"],
    { windowsHide: true, env: { ...env, CB_ROOT: large }, stdio: ['ignore', 'pipe', 'pipe'] });
  let completed = false;
  const finished = once(scanner, 'exit').then(() => { completed = true; });
  t.after(async () => {
    await finished;
    await rm(base, { recursive: true, force: true });
  });
  await once(scanner.stdout, 'data');
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop';Add-Type -Path $env:CB_HELPER;[WorkspaceLabelAccess]::PrepareExistingBounded($env:CB_ROOT,500,'')|ConvertTo-Json -Compress"],
    { windowsHide: true, timeout: 10000, env: { ...env, CB_ROOT: small } });
  assert.equal(completed, false, 'the small preparation must be measured while the large traversal is active');
  return JSON.parse(stdout);
}

test('a large workspace label traversal cannot consume another workspace label budget', {
  skip: process.platform !== 'win32', timeout: 45000,
}, async t => {
  const result = await prepareWhileScanning(t);
  assert.equal(result.Status, 'complete', JSON.stringify(result));
  assert.equal(result.Changed, 1);
});

test('overlapping workspaces still serialize before changing any shared descendant DACL', {
  skip: process.platform !== 'win32', timeout: 45000,
}, async t => {
  const result = await prepareWhileScanning(t, true);
  assert.equal(result.Status, 'deadline', JSON.stringify(result));
  assert.equal(result.Changed, 0, 'a nested preparation must not borrow ACL access during its parent traversal');
});
