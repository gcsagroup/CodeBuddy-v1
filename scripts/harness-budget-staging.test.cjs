const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { copyHarnessSources } = require('./stage-harness-distribution.cjs');

test('distribution keeps the serialized driver entry and every SDK budget seam, excluding tests and installed dependencies', async t => {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'codebuddy-budget-stage-'));
  t.after(() => fs.rm(target, { recursive: true, force: true }));
  const source = path.join(__dirname, '../runtime/harness');
  await copyHarnessSources(source, target);
  const required = [
    'index.mjs', 'driver.mjs', 'model-catalog.mjs', 'sdk-budget-contract.mjs',
    'subagent-return-contract.mjs', 'sdk-budget/adapter-patch.mjs', 'sdk-budget/vllm-count.mjs',
    'sdk-budget/llm-patch.mjs', 'sdk-budget/compaction-patch.mjs', 'sdk-budget/retry-patch.mjs',
  ];
  for (const file of required)
    assert.deepEqual(await fs.readFile(path.join(target, file)), await fs.readFile(path.join(source, file)));
  for (const directory of ['test', 'node_modules'])
    await assert.rejects(fs.access(path.join(target, directory)), { code: 'ENOENT' });
});
