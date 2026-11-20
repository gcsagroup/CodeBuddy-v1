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

test('Serena staging requires the native payload and its pinned provenance', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codebuddy-serena-stage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const assets = path.join(source, 'assets');
  const payload = path.join(assets, 'serena');
  const provenance = { source: 'https://github.com/oraios/serena', revision: 'pinned-fixture', packageVersion: '1.7.1.dev0', license: 'MIT', python: '3.12', platform: process.platform === 'win32' ? 'darwin' : 'win32', arch: 'x64' };
  await fs.mkdir(assets, { recursive: true });
  await fs.writeFile(path.join(assets, 'serena-runtime.json'), JSON.stringify(provenance));
  await assert.rejects(copyRuntimeSources(source, path.join(root, 'missing')), /Serena payload is missing/);
  await fs.mkdir(path.join(payload, 'serena'), { recursive: true });
  await fs.writeFile(path.join(payload, 'serena/cli.py'), '# isolated payload');
  await assert.rejects(copyRuntimeSources(source, path.join(root, 'wrong-platform')), /does not match/);
  const native = { ...provenance, platform: process.platform, arch: process.arch };
  await fs.writeFile(path.join(payload, '.codebuddy-runtime.json'), JSON.stringify({ ...native, revision: 'unapproved' }));
  await assert.rejects(copyRuntimeSources(source, path.join(root, 'wrong-revision')), /provenance mismatch: revision/);
  await fs.writeFile(path.join(payload, '.codebuddy-runtime.json'), JSON.stringify(native));
  const target = path.join(root, 'native');
  await copyRuntimeSources(source, target);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(target, 'assets/serena-runtime.json'), 'utf8')), native);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(assets, 'serena-runtime.json'), 'utf8')), provenance,
    'Building on another host must not rewrite shared source provenance');
});

test('code-navigation staging refuses a missing or substituted language server', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codebuddy-pyright-stage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const assets = path.join(source, 'assets');
  const payload = path.join(assets, 'pyright');
  const expected = { name: 'pyright', version: '1.1.403', license: 'MIT', url: 'https://registry.npmjs.org/fixture', integrity: 'fixture-digest' };
  await fs.mkdir(assets, { recursive: true });
  await fs.writeFile(path.join(assets, 'pyright-runtime.json'), JSON.stringify(expected));
  await assert.rejects(copyRuntimeSources(source, path.join(root, 'missing')), /Pyright payload is missing/);
  await fs.mkdir(path.join(payload, 'dist'), { recursive: true });
  await fs.writeFile(path.join(payload, 'dist/pyright-langserver.js'), '// fixture');
  await fs.writeFile(path.join(payload, '.codebuddy-runtime.json'), JSON.stringify({ ...expected, version: 'other' }));
  await assert.rejects(copyRuntimeSources(source, path.join(root, 'wrong')), /provenance mismatch: version/);
  await fs.writeFile(path.join(payload, '.codebuddy-runtime.json'), JSON.stringify(expected));
  await copyRuntimeSources(source, path.join(root, 'valid'));
  assert.equal(await fs.readFile(path.join(root, 'valid/assets/pyright/dist/pyright-langserver.js'), 'utf8'), '// fixture');
});
