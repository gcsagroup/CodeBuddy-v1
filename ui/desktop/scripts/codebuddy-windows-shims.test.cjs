const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const os = require('node:os');

const desktopRoot = path.resolve(__dirname, '..');
const authoredShimPath = path.join(
  desktopRoot,
  'src',
  'platform',
  'windows',
  'bin',
  'npx.cmd'
);
const generatedShimPath = path.join(desktopRoot, 'src', 'bin', 'npx.cmd');
const shimPaths = [authoredShimPath];

if (fs.existsSync(generatedShimPath)) {
  shimPaths.push(generatedShimPath);
}

for (const shimPath of shimPaths) {
  test(`${path.relative(desktopRoot, shimPath)} uses CodeBuddy-owned paths and messages`, () => {
    const source = fs.readFileSync(shimPath, 'utf8');

    assert.match(source, /%LOCALAPPDATA%\\CodeBuddy\\node/);
    assert.match(source, /\[CodeBuddy\]/);
    assert.doesNotMatch(source, /%LOCALAPPDATA%\\Goose\\node/);
    assert.doesNotMatch(source, /\[Goose\]/);
    assert.doesNotMatch(source, /%TEMP%\\goose-node/);
  });
}

test('Windows launcher reuses existing caches and prefers the new cache without downloading', { skip: process.platform !== 'win32' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-node-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seed = (brand) => {
    const directory = path.join(root, brand, 'node');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'node-v22.14.0.installed'), '');
    fs.writeFileSync(path.join(directory, 'npx.cmd'), `@echo ${brand}-cache\r\n@exit /b 0\r\n`);
  };
  seed('CodeAgentPro');
  const env = { ...process.env, LOCALAPPDATA: root };
  delete env.GOOSE_NODE_DIR;
  const run = () => spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', authoredShimPath], { env, encoding: 'utf8', windowsHide: true });
  const legacy = run();
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.match(legacy.stdout, /CodeAgentPro-cache/);
  seed('CodeBuddy');
  const current = run();
  assert.equal(current.status, 0, current.stderr);
  assert.match(current.stdout, /CodeBuddy-cache/);
  assert.ok(fs.existsSync(path.join(root, 'CodeAgentPro', 'node', 'node-v22.14.0.installed')));
});
