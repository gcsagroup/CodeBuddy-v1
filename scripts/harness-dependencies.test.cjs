const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dependencyClosure, commonJsImports } = require('./harness-dependencies.cjs');
const { createRequire } = require('node:module');

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
