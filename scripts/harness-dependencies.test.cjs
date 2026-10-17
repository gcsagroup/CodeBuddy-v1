const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dependencyClosure, commonJsImports, profilePackageNames } = require('./harness-dependencies.cjs');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

test('explicit Host plugins are packaged when import resolution follows a worktree node_modules junction', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-profile-deps-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modules = path.join(root, 'shared/node_modules');
  const plugin = path.join(modules, '@fixture/goal');
  fs.mkdirSync(path.join(plugin, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: '@fixture/goal' }));
  const pluginEntry = path.join(plugin, 'lib/index.js');
  fs.writeFileSync(pluginEntry, 'export default {};');
  const worktree = path.join(root, 'worktree');
  fs.mkdirSync(worktree);
  fs.symlinkSync(modules, path.join(worktree, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const localEntry = path.join(worktree, 'instructions.mjs');
  fs.writeFileSync(localEntry, 'export default {};');
  const entries = [pluginEntry, localEntry].map(file => ({ name: pathToFileURL(file).href }));
  assert.deepEqual([...profilePackageNames(entries, path.join(worktree, 'node_modules'))], ['@fixture/goal']);
});

test('captures CommonJS adapter imports without treating comments as dependencies', () => {
  const typescript = createRequire(path.resolve(__dirname, '../ui/desktop/package.json'))('typescript');
  const source = '// require("unused")\nconst ip = require("ipaddr.js"); const os = require("node:os"); const text = \'require("not-code")\';';
  assert.deepEqual([...commonJsImports(source, typescript)], ['ipaddr.js']);
  assert.throws(() => commonJsImports('require(computedName)', typescript), /Dynamic require/);
});

test('runtime closure preserves nested versions, peers and optional availability without CLI/dev dependencies', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-deps-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = (directory, manifest) => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest));
    return directory;
  };
  const a = pkg(path.join(root, 'node_modules/a'), { dependencies: { shared: '1', b: '1' }, optionalDependencies: { missing: '1' }, peerDependencies: { peer: '1' }, devDependencies: { cli: '1' } });
  const shared = pkg(path.join(root, 'node_modules/shared'), { version: '1' });
  const b = pkg(path.join(root, 'node_modules/b'), { dependencies: { shared: '2', a: '1' } });
  const nested = pkg(path.join(b, 'node_modules/shared'), { version: '2' });
  const peer = pkg(path.join(root, 'node_modules/peer'), {});
  pkg(path.join(root, 'node_modules/cli'), {});
  assert.deepEqual(new Set(dependencyClosure(['a'], root)), new Set([a, shared, b, nested, peer]));
  pkg(path.join(root, 'node_modules/broken'), { dependencies: { required: '1' } });
  assert.throws(() => dependencyClosure(['broken'], root), /Missing runtime dependency required/);
});
