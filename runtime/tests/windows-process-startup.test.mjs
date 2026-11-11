import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, copyFile, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('consoleless desktop: restricted children start hidden, DLL failure returns without a modal, next call still runs', { skip: process.platform !== 'win32', timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cb-startup-audit-'));
  const fixtures = new URL('./fixtures/windows-startup/', import.meta.url);
  const vswhere = join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio/Installer/vswhere.exe');
  const vs = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true }).trim();
  assert.ok(vs, 'existing MSVC Build Tools required; do not download a compiler');
  for (const file of ['failing-dll.c', 'failing-app.c', 'process-state.c']) await copyFile(new URL(file, fixtures), join(root, file));
  await writeFile(join(root, 'build.cmd'), `@echo off\r\ncall "${vs}\\VC\\Auxiliary\\Build\\vcvars64.bat" >nul\r\ncl /nologo /LD /MD failing-dll.c /link /OUT:cb-failing-dll.dll /IMPLIB:cb-failing-dll.lib\r\nif errorlevel 1 exit /b 1\r\ncl /nologo /MD failing-app.c cb-failing-dll.lib /Fe:cb-failing-app.exe\r\nif errorlevel 1 exit /b 1\r\ncl /nologo /MD process-state.c user32.lib /Fe:cb-process-state.exe\r\nexit /b %errorlevel%\r\n`);
  execFileSync(process.env.ComSpec, ['/d', '/c', 'build.cmd'], { cwd: root, windowsHide: true, timeout: 30000 });
  const python = process.env.CB_STARTUP_TEST_PYTHON ?? execFileSync('where.exe', ['python.exe'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0];
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('audit.mjs', fixtures)), root], {
    windowsHide: true, timeout: 75000, maxBuffer: 1024 * 1024, env: { ...process.env, CB_STARTUP_TEST_PYTHON: python },
  });
  assert.equal(JSON.parse(result.stdout.trim()).passed, 7);
  const receipts = JSON.parse(await readFile(join(root, 'receipts.json'), 'utf8'));
  assert.equal(receipts.length, 7);
  console.log('Windows startup receipts: ' + root);
});
