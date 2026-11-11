import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Emulate the desktop GUI carrier: it has no inherited console. Do this only
// in this isolated worker, never detach the test runner/user terminal.
const require = createRequire(new URL('../../../harness/package.json', import.meta.url));
const k = require('koffi'), dll = k.load('kernel32.dll');
dll.func('__stdcall', 'FreeConsole', 'int', [])();
assert.equal(dll.func('__stdcall', 'GetConsoleProcessList', 'uint32', ['void *', 'uint32'])(Buffer.alloc(4), 1), 0);
const { createHarnessDriver } = await import('../../../harness/index.mjs');
const root = process.argv[2];
const driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd: root });
const receipts = [];
try {
  const session = await driver.createSession({ cwd: root, provider: { id: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture' }, model: 'fixture', options: {} });
  const call = async command => {
    const result = await driver.callTool(session.sessionId, 'pwsh', { command, description: 'Native startup regression' }, { onPermission: () => false });
    receipts.push({ command, result });
    assert.equal(result.value?.timedOut, false, JSON.stringify(result));
    assert.equal(result.value?.aborted, false, JSON.stringify(result));
    assert.equal(result.value?.sandbox.mode, 'workspace-write');
    return result.value;
  };
  for (const command of ['& .\\cb-process-state.exe', "& $env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -NonInteractive -Command '& .\\cb-process-state.exe'"]) {
    const value = await call(command);
    assert.equal(value.exitCode, 0);
    const state = JSON.parse(value.stdout.text.trim());
    assert.ok(state.console > 0, 'restricted children need an inherited console');
    assert.equal(state.visible, 0, 'no console window is exposed');
    assert.equal(state.mode & 1, 1, 'critical loader errors must return, never open a modal');
  }
  const where = await call('where.exe cmd.exe');
  assert.equal(where.exitCode, 0); assert.match(where.stdout.text, /cmd\.exe/i);
  // This EXE really imports a DLL whose DllMain returns FALSE. It is not a
  // simulated exit code: a modal regression would block the worker deadline.
  for (const command of ['& .\\cb-failing-app.exe', "& $env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -NonInteractive -Command '& .\\cb-failing-app.exe; exit $LASTEXITCODE'"]) {
    const failed = await call(command);
    assert.notEqual(failed.exitCode, 0);
    assert.match(failed.stderr.text, /0xC0000142|-1073741502|3221225794/i);
    assert.equal(failed.sandbox.denied, false, 'DLL failure is not evidence of an ACL denial');
  }
  const python = process.env.CB_STARTUP_TEST_PYTHON;
  assert.ok(python, 'the Windows acceptance job must supply its installed Python');
  const py = "& '" + python.replaceAll("'", "''") + "'";
  const nested = await call(py + ' -c "import subprocess; print(subprocess.check_output([\'where.exe\',\'cmd.exe\']).decode()); p=subprocess.run([\'.\\\\cb-failing-app.exe\'],timeout=10); print(p.returncode); raise SystemExit(1 if p.returncode else 0)"');
  assert.notEqual(nested.exitCode, 0);
  assert.match(nested.stdout.text, /cmd\.exe/i);
  assert.match(nested.stdout.text, /3221225794/);
  const recovered = await call("Write-Output 'AFTER_FAILURE'");
  assert.equal(recovered.exitCode, 0); assert.match(recovered.stdout.text, /AFTER_FAILURE/);
} finally {
  await driver.close();
  await writeFile(join(root, 'receipts.json'), JSON.stringify(receipts, null, 2));
}
console.log(JSON.stringify({ passed: receipts.length, root }));
