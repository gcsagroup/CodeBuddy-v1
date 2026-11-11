import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessDriver } from '../harness/index.mjs';

test('native sandbox PowerShell does not mask statement failures; explicit recovery still works', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cb-command-audit-'));
  const driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd: root });
  t.after(() => driver.close());
  const session = await driver.createSession({ cwd: root, provider: { id: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture' }, model: 'fixture', options: {} });
  for (const [command, failure, output] of [
    ["CB_Audit_Missing_Command; Write-Output 'MASKED'", true],
    ["Write-Error 'failure'; Write-Output 'MASKED'", true],
    ["& $env:ComSpec /c 'exit 7'; Write-Output 'MASKED'", true],
    ['exit 7', true],
    ["try { Write-Error 'expected' } catch { Write-Output 'RECOVERED' }", false, 'RECOVERED'],
    ["Write-Output '正常输出'", false, '正常输出'],
  ]) {
    const result = await driver.callTool(session.sessionId, 'pwsh', { command, description: 'Audit command status' }, { onPermission: () => false });
    const value = result.value;
    assert.ok(value, JSON.stringify(result));
    assert.equal(value.exitCode !== 0, failure, JSON.stringify(result));
    assert.doesNotMatch(value.stdout.text, /MASKED/);
    if (output) assert.ok(value.stdout.text.includes(output));
  }
});
