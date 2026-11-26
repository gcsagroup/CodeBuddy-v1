import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarnessDriver } from '../harness/index.mjs';

test('real Windows terminal writes only primary and linked writable folders, never reference folders', {
  skip: process.platform !== 'win32', timeout: 120000,
}, async t => {
  // Repository-drive inheritance differs from the user's TEMP ACL. Exercise
  // the actual D: project boundary that exposed the grant preparation failure.
  await mkdir(join(process.cwd(), '.local'), { recursive: true });
  const root = await mkdtemp(join(process.cwd(), '.local', 'codebuddy-multi-project-'));
  const primary = join(root, 'main'), linked = join(root, 'linked'), reference = join(root, 'reference');
  await Promise.all([primary, linked, reference].map(path => mkdir(path)));
  await writeFile(join(reference, 'keep.txt'), 'original');
  let writable = [linked];
  const driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd: primary,
    projectFolders: { executionFolders: async () => ({ writable, reference: [reference] }) } });
  t.after(async () => { await driver.close(); await rm(root, { recursive: true, force: true }); });
  const { sessionId } = await driver.createSession({ cwd: primary, initialPermissionPreset: 'workspace-write', model: 'fixture',
    provider: { id: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-only' } });
  const result = await driver.callTool(sessionId, 'pwsh', {
    command: `Set-Content -LiteralPath '${join(primary, 'proof.txt')}' -Value MAIN; Set-Content -LiteralPath '${join(linked, 'proof.txt')}' -Value LINKED; Get-Content -LiteralPath '${join(reference, 'keep.txt')}'`,
    description: 'Verify multi-project sandbox',
  }, { onPermission: () => true });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.value.exitCode, 0, JSON.stringify(result));
  assert.equal((await readFile(join(linked, 'proof.txt'), 'utf8')).trim(), 'LINKED');
  assert.equal((await readFile(join(primary, 'proof.txt'), 'utf8')).trim(), 'MAIN');
  const denied = await driver.callTool(sessionId, 'pwsh', {
    command: `Set-Content -LiteralPath '${join(reference, 'keep.txt')}' -Value CHANGED`, description: 'Verify reference protection',
  }, { onPermission: () => true });
  assert.notEqual(denied.value?.exitCode, 0, JSON.stringify(denied));
  assert.equal(await readFile(join(reference, 'keep.txt'), 'utf8'), 'original');
  const background = await driver.callTool(sessionId, 'pwsh', {
    command: `Set-Content -LiteralPath '${join(linked, 'background.txt')}' -Value BACKGROUND_OK`,
    description: 'Verify linked folder background permissions', run_in_background: true,
  }, { onPermission: () => true });
  assert.equal(background.isError, false, JSON.stringify(background));
  let backgroundText;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { backgroundText = await readFile(join(linked, 'background.txt'), 'utf8'); break; } catch { await delay(100); }
  }
  assert.equal(backgroundText?.trim(), 'BACKGROUND_OK');
  await driver.permissions(sessionId, { cwd: primary, preset: 'danger-full-access' });
  const full = await driver.callTool(sessionId, 'pwsh', {
    command: `Set-Content -LiteralPath '${join(reference, 'keep.txt')}' -Value CHANGED`, description: 'Verify full access cannot bypass reference protection',
  }, { onPermission: () => true });
  assert.equal(full.isError, true, JSON.stringify(full));
  assert.equal(await readFile(join(reference, 'keep.txt'), 'utf8'), 'original');
  writable = [];
  await driver.permissions(sessionId, { cwd: primary, preset: 'workspace-write' });
  const removed = await driver.callTool(sessionId, 'pwsh', {
    command: `Set-Content -LiteralPath '${join(linked, 'proof.txt')}' -Value LEAKED`, description: 'Verify removed membership cannot reuse standing grants',
  }, { onPermission: () => true });
  assert.notEqual(removed.value?.exitCode, 0, JSON.stringify(removed));
  assert.equal((await readFile(join(linked, 'proof.txt'), 'utf8')).trim(), 'LINKED');
});
