import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
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
    const escape = join(sibling, 'outside.txt');
    await call("Set-Content -LiteralPath '" + escape.replaceAll("'", "''") + "' -Value 'escaped'");
    await assert.rejects(readFile(escape), { code: 'ENOENT' });
  } finally { await driver.close(); }
  const prepared = descriptor(root);
  assert.equal(prepare(root), 'True');
  assert.equal(descriptor(root), prepared);
  assert.equal(descriptor(base), parentBefore);
  assert.equal(descriptor(child), childBefore);
  assert.match(descriptor(root), new RegExp('\\(A;;WO;;;' + sid + '\\)'));
  assert.ok(!descriptor(child).includes('(A;;WO;;;' + sid + ')'));
  assert.ok(!childBefore.includes('(A;;WO;;;' + sid + ')'));
});
