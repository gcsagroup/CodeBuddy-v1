import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));
function run(source) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd, encoding: 'utf8', timeout: 30000,
  });
}

test('public driver, metadata-first, and real server imports share the checked SDK identities', () => {
  for (const entry of ['./index.mjs', './model-catalog.mjs', '../server.mjs']) {
    const child = run(`
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      import { createHash } from 'node:crypto';
      const paths = ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-llm-retry'];
      const digest = name => createHash('sha256').update(readFileSync(new URL(import.meta.resolve(name)))).digest('hex');
      const before = paths.map(digest);
      await import(${JSON.stringify(entry)});
      const { HARNESS_VERSION, createHarnessDriver } = await import('./index.mjs');
      const { LlmRuntime, LlmError } = await import('@deepseek-ai/dsh-llm');
      assert.equal(HARNESS_VERSION, '0.2.1-alpha.2');
      assert.equal(typeof createHarnessDriver, 'function');
      assert.equal(typeof LlmRuntime.prototype.requestFitRecovery, 'function');
      assert.strictEqual(LlmError, (await import('@deepseek-ai/dsh-llm')).LlmError);
      assert.deepEqual(paths.map(digest), before, 'never patch installed dependency files');
    `);
    assert.equal(child.status, 0, `${entry}: ${child.error?.message ?? ''}\n${child.stderr}`);
  }
});

test('late SDK loading fails explicitly instead of silently using an unpatched module', () => {
  const child = run(`
    await import('@deepseek-ai/dsh-llm');
    await import('./sdk-budget-contract.mjs');
  `);
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stderr, /Load the SDK request-fit contract before @deepseek-ai\/dsh-llm/);
});

test('SDK and Pi helper byte drift are rejected before native loading without editing dependencies', () => {
  for (const name of ['@deepseek-ai/dsh-llm', '@earendil-works/pi-ai/api/simple-options']) {
    const child = run(`
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const target = new URL(import.meta.resolve(${JSON.stringify(name)})).href;
      const original = fs.readFileSync;
      fs.readFileSync = function(path, ...args) {
        const result = original.call(this, path, ...args);
        return path instanceof URL && path.href === target ? result + '\\n' : result;
      };
      syncBuiltinESMExports();
      await import('./sdk-budget-contract.mjs');
    `);
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, /Review the pinned (SDK request-fit contract|Pi request-fit helper)/);
  }
});
