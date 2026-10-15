const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const {
  stageBackend,
  verifyStage,
  verifyMachO,
  stagePty,
  preparePty,
  verifyBundle,
  targetFor,
  bundlePaths,
  sha256,
  verifyArtifact,
} = require('./macos-package.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const desktop = path.join(root, 'ui/desktop');
  fs.mkdirSync(path.join(desktop, 'src/bin'), { recursive: true });
  for (const name of ['node', 'npx', 'node-setup-common.sh', 'uvx', 'jbang'])
    fs.writeFileSync(path.join(desktop, 'src/bin', name), '#!/bin/bash\r\nexit 0\r\n');
  fs.writeFileSync(path.join(desktop, 'src/bin', 'goose.exe'), 'development backend');
  fs.writeFileSync(path.join(desktop, 'codebuddy.distro.json'), '{"productName":"Fixture App"}');
  return { root, desktop };
}

function macho(file, arch) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
  fs.writeFileSync(file, bytes);
}

function backendFixture(file, arch) {
  macho(file, arch);
  for (const name of ['qwen-computer-use', 'qwen-computer-runtime'])
    macho(path.join(path.dirname(file), name), arch);
}

test('stages hoisted PTY runtime and rebuild headers into a Vite-only package', (t) => {
  const { root, desktop } = fixture(t);
  const ptyRoot = path.join(root, 'ui/node_modules/node-pty');
  const headersRoot = path.join(root, 'ui/node_modules/node-addon-api');
  fs.mkdirSync(headersRoot, { recursive: true });
  fs.writeFileSync(path.join(headersRoot, 'package.json'), '{"name":"node-addon-api"}');
  fs.writeFileSync(path.join(headersRoot, 'napi.h'), 'header fixture');
  const native = path.join(ptyRoot, 'prebuilds/darwin-arm64');
  macho(path.join(native, 'pty.node'), 'arm64');
  macho(path.join(native, 'spawn-helper'), 'arm64');
  fs.writeFileSync(path.join(ptyRoot, 'package.json'), '{"name":"node-pty"}');
  fs.writeFileSync(path.join(ptyRoot, 'index.js'), 'runtime fixture');
  assert.throws(() => preparePty(desktop, 'arm64'), /Missing macOS node-pty/);
  stagePty(desktop, ptyRoot);
  preparePty(desktop, 'arm64');
  assert.equal(
    fs.readFileSync(path.join(desktop, 'node_modules/node-pty/index.js'), 'utf8'),
    'runtime fixture'
  );
  assert.equal(
    fs.readFileSync(path.join(desktop, 'node_modules/node-addon-api/napi.h'), 'utf8'),
    'header fixture'
  );
  assert.throws(() => stagePty(desktop, ptyRoot), /exist/i);
});

for (const arch of ['arm64', 'x64']) {
  test(`${arch}: stage only matching backend and executable POSIX shims`, (t) => {
    const { root, desktop } = fixture(t);
    const backend = path.join(root, 'release/goose');
    backendFixture(backend, arch);
    const staged = stageBackend(desktop, backend, arch, { revision: 'fixture' });
    const manifest = verifyStage(desktop, staged.resourceDirectory, staged.manifestPath, arch);
    assert.equal(manifest.target, targetFor(arch));
    assert.deepEqual(fs.readdirSync(staged.resourceDirectory).sort(), [
      'goose',
      'jbang',
      'node',
      'node-setup-common.sh',
      'npx',
      'qwen-computer-runtime',
      'qwen-computer-use',
      'uvx',
    ]);
    assert.equal(
      fs.readFileSync(path.join(desktop, 'src/bin/goose.exe'), 'utf8'),
      'development backend'
    );
    assert.doesNotMatch(fs.readFileSync(path.join(staged.resourceDirectory, 'node'), 'utf8'), /\r/);
    if (process.platform !== 'win32')
      assert.ok(fs.statSync(path.join(staged.resourceDirectory, 'node')).mode & 0o111);
    fs.appendFileSync(path.join(staged.resourceDirectory, 'goose'), 'tampered');
    assert.throws(
      () => verifyStage(desktop, staged.resourceDirectory, staged.manifestPath, arch),
      /manifest/
    );
  });
  test(`${arch}: validates Electron addon and spawn-helper before signing`, (t) => {
    const { desktop } = fixture(t);
    const native = path.join(desktop, 'node_modules/node-pty/build/Release');
    macho(path.join(native, 'pty.node'), arch);
    assert.throws(() => preparePty(desktop, arch), /ENOENT/);
    macho(path.join(native, 'spawn-helper'), arch);
    preparePty(desktop, arch);
    if (process.platform !== 'win32')
      assert.ok(fs.statSync(path.join(native, 'spawn-helper')).mode & 0o111);
    assert.throws(() => preparePty(desktop, arch === 'arm64' ? 'x64' : 'arm64'), /Mach-O/);
  });
}

test('rejects wrong architecture, PE, truncated binaries and unsupported universal builds', (t) => {
  const { root } = fixture(t);
  const file = path.join(root, 'goose');
  backendFixture(file, 'arm64');
  assert.throws(() => verifyMachO(file, 'x64'), /Mach-O/);
  fs.writeFileSync(file, 'MZ fake Windows executable');
  assert.throws(() => verifyMachO(file, 'arm64'), /Mach-O/);
  assert.throws(() => targetFor('universal'), /Unsupported/);
});

test('stage verification rejects unstaged paths and mismatched target metadata', (t) => {
  const { root, desktop } = fixture(t);
  const file = path.join(root, 'goose');
  backendFixture(file, 'arm64');
  const staged = stageBackend(desktop, file, 'arm64', {});
  assert.throws(() => verifyStage(desktop, root, staged.manifestPath, 'arm64'), /inside/);
  const manifest = JSON.parse(fs.readFileSync(staged.manifestPath));
  manifest.target = 'x86_64-apple-darwin';
  fs.writeFileSync(staged.manifestPath, JSON.stringify(manifest));
  assert.throws(
    () => verifyStage(desktop, staged.resourceDirectory, staged.manifestPath, 'arm64'),
    /manifest/
  );
});

test('artifact paths use distribution identity for both architectures', (t) => {
  const { desktop } = fixture(t);
  assert.equal(path.basename(bundlePaths(desktop, 'arm64').zip), 'Fixture App.zip');
  assert.equal(path.basename(bundlePaths(desktop, 'x64').zip), 'Fixture App_intel_mac.zip');
  assert.equal(path.basename(bundlePaths(desktop, 'x64').app), 'Fixture App.app');
  assert.equal(path.basename(bundlePaths(desktop, 'arm64').dmg), 'Fixture App-arm64.dmg');
  assert.equal(path.basename(bundlePaths(desktop, 'x64').dmg), 'Fixture App-x64.dmg');
});

test('artifact checksum covers chunk boundaries and the last partial block', (t) => {
  const { root } = fixture(t);
  const file = path.join(root, 'artifact.dmg');
  const bytes = Buffer.alloc(1024 * 1024 + 71, 0x61);
  fs.writeFileSync(file, bytes);
  assert.equal(
    sha256(file),
    require('node:crypto').createHash('sha256').update(bytes).digest('hex')
  );
  bytes[bytes.length - 1] = 0x62;
  fs.writeFileSync(file, bytes);
  assert.equal(
    sha256(file),
    require('node:crypto').createHash('sha256').update(bytes).digest('hex')
  );
});

test('installation rejects missing, altered and wrong-architecture delivery manifests', (t) => {
  const { root } = fixture(t);
  const dmg = path.join(root, 'Fixture.dmg');
  fs.writeFileSync(dmg, 'fixture image');
  assert.throws(() => verifyArtifact(dmg, 'arm64'), /ENOENT/);
  const manifest = {
    schemaVersion: 1,
    arch: 'arm64',
    artifacts: [{ file: path.basename(dmg), bytes: fs.statSync(dmg).size, sha256: sha256(dmg) }],
  };
  fs.writeFileSync(path.join(root, 'artifacts.json'), JSON.stringify(manifest));
  assert.deepEqual(verifyArtifact(dmg, 'arm64'), manifest);
  assert.throws(() => verifyArtifact(dmg, 'x64'), /manifest/);
  // Same length: hashing must detect substitution, not just size changes.
  fs.writeFileSync(dmg, 'altered image');
  assert.throws(() => verifyArtifact(dmg, 'arm64'), /manifest/);
});

test('Forge parses --arch= syntax and preserves native rebuild for macOS', () => {
  const config = path.resolve(__dirname, '../forge.config.ts');
  const run = spawnSync(
    process.execPath,
    [
      '-e',
      `const c=require(${JSON.stringify(config)});console.log(JSON.stringify({rebuild:c.rebuildConfig,sign:c.packagerConfig.osxSign?.optionsForFile(),id:c.packagerConfig.appBundleId}));`,
      '--',
      '--platform=darwin',
      '--arch=x64',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        APPLE_TEAM_ID: 'fixture',
        APPLE_ID: 'fixture@example.invalid',
        APPLE_ID_PASSWORD: 'fixture',
      },
    }
  );
  assert.equal(run.status, 0, run.stderr);
  const configValue = JSON.parse(run.stdout);
  assert.deepEqual(configValue.rebuild.ignoreModules, []);
  assert.ok(configValue.sign.entitlements.endsWith('entitlements.plist'));
  assert.equal(configValue.id, 'local.codebuddy.desktop');
});

test('bundle help is available without downloading or building', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'bundle-macos.cjs'), '--help'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /arm64\|x64/);
});

test('packaging refuses a missing or wrong-architecture computer runtime', (t) => {
  const { root, desktop } = fixture(t);
  const backend = path.join(root, 'release/goose');
  macho(backend, 'arm64');
  assert.throws(() => stageBackend(desktop, backend, 'arm64', {}), /ENOENT/);
  backendFixture(backend, 'arm64');
  macho(path.join(root, 'release/qwen-computer-runtime'), 'x64');
  assert.throws(() => stageBackend(desktop, backend, 'arm64', {}), /Mach-O/);
});

test('stage verification detects computer runtime substitution', (t) => {
  const { root, desktop } = fixture(t);
  const backend = path.join(root, 'release/goose');
  backendFixture(backend, 'arm64');
  const stage = stageBackend(desktop, backend, 'arm64', {});
  fs.appendFileSync(path.join(stage.resourceDirectory, 'qwen-computer-runtime'), 'changed');
  assert.throws(
    () => verifyStage(desktop, stage.resourceDirectory, stage.manifestPath, 'arm64'),
    /manifest mismatch/
  );
});

test('packaged verification requires the unpacked native helper and records final backend hash', (t) => {
  const { root, desktop } = fixture(t);
  const backend = path.join(root, 'release/goose');
  backendFixture(backend, 'arm64');
  const stage = stageBackend(desktop, backend, 'arm64', {});
  const app = path.join(root, 'Fixture.app');
  const resources = path.join(app, 'Contents/Resources');
  fs.mkdirSync(path.join(resources, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(stage.resourceDirectory, 'goose'), path.join(resources, 'bin/goose'));
  fs.chmodSync(path.join(resources, 'bin/goose'), 0o755);
  assert.throws(() => verifyBundle(app, 'arm64', stage.manifestPath), /node-pty/);
  const native = path.join(resources, 'app.asar.unpacked/node_modules/node-pty/build/Release');
  macho(path.join(native, 'pty.node'), 'arm64');
  macho(path.join(native, 'spawn-helper'), 'arm64');
  fs.chmodSync(path.join(native, 'spawn-helper'), 0o755);
  for (const name of ['qwen-computer-use', 'qwen-computer-runtime']) {
    fs.copyFileSync(path.join(stage.resourceDirectory, name), path.join(resources, 'bin', name));
    fs.chmodSync(path.join(resources, 'bin', name), 0o755);
  }
  const verified = verifyBundle(app, 'arm64', stage.manifestPath);
  assert.equal(verified.packagedBackendSha256, verified.backendSha256);
});
