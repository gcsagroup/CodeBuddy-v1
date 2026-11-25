import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, link, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import '../harness/index.mjs';

const run = promisify(execFile);
const require = createRequire(new URL('../harness/package.json', import.meta.url));
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
const { default: NativeWindowsSandboxProvider } = await import('../harness/windows-sandbox-native.mjs');
const ps = (command, env = {}) => run('powershell.exe', [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop';" + command,
], { windowsHide: true, timeout: 8000, env: { ...process.env, ...env } });
const icacls = (...args) => run('icacls.exe', args, { windowsHide: true, timeout: 5000 });

test('Windows label preparation rechecks existing files when they become eligible', {
  skip: process.platform !== 'win32' || process.arch !== 'x64', timeout: 45000,
}, async t => {
  const base = await mkdtemp(join(tmpdir(), 'codebuddy-label-eligibility-'));
  const root = join(base, 'workspace');
  const readOnly = join(root, 'read-only.txt');
  const linked = join(root, 'linked.txt');
  const insideAlias = join(root, 'inside-alias.txt');
  const protectedDacl = join(root, 'protected-dacl.txt');
  const outsideLinked = join(root, 'outside-linked.txt');
  const outsideAlias = join(base, 'outside-alias.txt');
  const labelled = join(root, 'labelled.txt');
  const initiallyDenied = join(root, 'initially-denied.txt');
  const deniedAlias = join(base, 'denied-alias.txt');
  const context = new Context();
  let user;
  t.after(async () => {
    try { await context.fiber.dispose(); }
    finally {
      await chmod(readOnly, 0o666).catch(() => {});
      if (typeof user === 'string') await icacls(initiallyDenied, '/remove:d', user).catch(() => {});
      await rm(base, { recursive: true, force: true });
    }
  });
  await mkdir(root);
  for (const path of [readOnly, linked, protectedDacl, outsideLinked, labelled, initiallyDenied]) await writeFile(path, 'fixture');
  await link(linked, insideAlias);
  await link(outsideLinked, outsideAlias);
  await link(initiallyDenied, deniedAlias);
  const { stdout } = await ps('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
  user = '*' + stdout.trim();
  await icacls(root, '/grant:r', user + ':(OI)(CI)(M)');
  await icacls(root, '/inheritance:r');
  await icacls(protectedDacl, '/inheritance:d');
  // The external host edit clears only this file's mandatory label.
  await icacls(labelled, '/grant', user + ':(WO)');
  await chmod(readOnly, 0o444);
  await icacls(initiallyDenied, '/deny', user + ':(WD)');

  await context.plugin(NativeWindowsSandboxProvider, {});
  const sandbox = context.sandbox;
  const policy = { mode: 'workspace-write', workspaceRoot: root, sessionId: 'eligibility-fixture' };
  const confine = () => {
    sandbox.preparationDeadline = Date.now() + 15000;
    return sandbox.confine(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop';[IO.File]::WriteAllText($env:CB_FILE,'restricted-update')"], policy);
  };
  const restrictedWrite = (confined, path) => run(confined.argv[0], confined.argv.slice(1), {
    cwd: root, windowsHide: true, timeout: 7000, env: { ...process.env, CB_FILE: path },
  });
  async function verifyRecovery(path) {
    // External mutations use the native observer. Give it time to deliver
    // notifications so the test distinguishes missed events from races.
    await delay(100);
    const confined = await confine();
    try { await restrictedWrite(confined, path); }
    catch (error) {
      const denied = error.stderr?.includes('UnauthorizedAccessException') ? ' (access denied)' : '';
      assert.fail(`The restricted write exited with ${error.code}${denied}`);
    }
    assert.equal(await readFile(path, 'utf8'), 'restricted-update');
  }
  const baseline = await confine();
  await restrictedWrite(baseline, labelled);

  await t.test('clearing the read-only attribute in place', async () => {
    await chmod(readOnly, 0o666);
    await verifyRecovery(readOnly);
  });
  await t.test('removing an alias inside the observed directory', async () => {
    await unlink(insideAlias);
    await verifyRecovery(linked);
  });
  await t.test('restoring DACL inheritance in place', async () => {
    await icacls(protectedDacl, '/inheritance:e');
    await verifyRecovery(protectedDacl);
  });
  await t.test('removing an alias outside the observed directory', async () => {
    await unlink(outsideAlias);
    await verifyRecovery(outsideLinked);
  });
  await t.test('recovering a denied open through an alias outside the observed directory', async () => {
    // Named DACL APIs may recompute inheritance from the alias's parent.
    // Edit this pinned object's DACL directly to preserve the original native
    // write grant, isolating the missing observation from grant inheritance.
    await ps(`
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using System.Security.AccessControl;
public static class ExternalDeniedOpenEdit {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string path, uint rights, uint share,
        IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("ntdll.dll")]
    static extern int NtSetSecurityObject(SafeFileHandle file, uint info, byte[] descriptor);
    public static void RemoveDenials(string path, byte[] descriptor) {
        var security = new RawSecurityDescriptor(descriptor, 0);
        for (int i = security.DiscretionaryAcl.Count - 1; i >= 0; i--) {
            var ace = security.DiscretionaryAcl[i] as QualifiedAce;
            if (ace != null && ace.AceQualifier == AceQualifier.AccessDenied)
                security.DiscretionaryAcl.RemoveAce(i);
        }
        if ((security.ControlFlags & ControlFlags.DiscretionaryAclAutoInherited) != 0)
            security.SetFlags(security.ControlFlags | ControlFlags.DiscretionaryAclAutoInheritRequired);
        var updated = new byte[security.BinaryLength]; security.GetBinaryForm(updated, 0);
        using (var handle = CreateFileW(path, 0x40000, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
            if (handle.IsInvalid) throw new System.ComponentModel.Win32Exception();
            int status = NtSetSecurityObject(handle, 4, updated);
            if (status != 0) throw new Exception("Could not restore the fixture DACL");
        }
    }
}
'@
      [ExternalDeniedOpenEdit]::RemoveDenials($env:CB_FILE,
        (Get-Acl -LiteralPath $env:CB_FILE).GetSecurityDescriptorBinaryForm())
    `, { CB_FILE: deniedAlias,
      PSModulePath: join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules') });
    await unlink(deniedAlias);
    await verifyRecovery(initiallyDenied);
  });
  async function clearLabel(path) {
    await ps(`
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ExternalLabelEdit {
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
    public static extern uint SetNamedSecurityInfoW(string path, uint type, uint info,
        IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
}
'@
      $none=[IntPtr]::Zero
      $status=[ExternalLabelEdit]::SetNamedSecurityInfoW($env:CB_FILE,1,16,$none,$none,$none,$none)
      if ($status -ne 0) { throw "Could not clear the fixture label (Win32 $status)" }
    `, { CB_FILE: path });
  }
  await t.test('removing the explicit label from an already writable file', async () => {
    await clearLabel(labelled);
    await assert.rejects(restrictedWrite(baseline, labelled),
      error => error.code === 1 && error.stderr?.includes('UnauthorizedAccessException'),
      'the previously usable command must be denied after the external label removal');
    await verifyRecovery(labelled);
  });
  await t.test('restoring a label changed through a new external alias after initialization', async () => {
    // Flush the initialization's own security notifications first: an old
    // event must not accidentally mask a later unobserved alias mutation.
    await delay(150); await confine();
    await delay(150); await confine();
    const alias = join(base, 'new-external-alias.txt');
    await link(labelled, alias);
    await clearLabel(alias);
    await unlink(alias);
    await assert.rejects(restrictedWrite(baseline, labelled),
      error => error.code === 1 && error.stderr?.includes('UnauthorizedAccessException'),
      'the alias edit must revoke the previously usable restricted write');
    await verifyRecovery(labelled);
  });

});
