const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { copyRuntimeSources } = require('./stage-harness-distribution.cjs');

test('runtime staging excludes legacy distribution credentials while retaining runtime sources', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codebuddy-no-shared-key-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  await fs.mkdir(path.join(source, 'assets'), { recursive: true });
  await fs.writeFile(path.join(source, 'distribution-credentials.json'), '{"apiKey":"fixture-never-ship"}');
  await fs.writeFile(path.join(source, 'default-model.json'), '{"providerId":"custom_lan"}');
  await fs.writeFile(path.join(source, 'server.mjs'), 'export const fixture = true;');
  await fs.writeFile(path.join(source, 'assets', 'fixture.txt'), 'asset');
  await copyRuntimeSources(source, target);
  await assert.rejects(fs.access(path.join(target, 'distribution-credentials.json')), { code: 'ENOENT' });
  for (const file of ['default-model.json', 'server.mjs', 'assets/fixture.txt']) {
    assert.deepEqual(await fs.readFile(path.join(target, file)), await fs.readFile(path.join(source, file)));
  }
});
