import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

test('the real server import graph can boot its lazily loaded native driver', { timeout: 15000 }, async () => {
  const script = `
    await import('./runtime/server.mjs');
    const { createHarnessDriver } = await import('./runtime/harness/index.mjs');
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dataDir = await mkdtemp(join(tmpdir(), 'codebuddy-server-contract-'));
    const driver = await createHarnessDriver({ dataDir });
    await driver.close();
    console.log('SERVER_NATIVE_BOOT_OK');
  `;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('../../', import.meta.url), timeout: 12000,
  });
  assert.match(stdout, /SERVER_NATIVE_BOOT_OK/);
});
