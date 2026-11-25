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
  verifySourceSnapshot,
} = require('./macos-package.cjs');

test('synchronized source identity requires matching file bytes and rejects traversal', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'source.js');
  const manifest = path.join(root, 'source.json');
  fs.writeFileSync(file, 'current source');
  const data = { revision: 'a'.repeat(40), dirty: true, files: { 'source.js': sha256(file) } };
  fs.writeFileSync(manifest, JSON.stringify(data));
  assert.equal(verifySourceSnapshot(root, manifest).verifiedFiles, 1);
  fs.writeFileSync(file, 'stale source');
  assert.throws(() => verifySourceSnapshot(root, manifest), /snapshot mismatch/);
  data.files = { '../outside': sha256(file) };
  fs.writeFileSync(manifest, JSON.stringify(data));
  assert.throws(() => verifySourceSnapshot(root, manifest), /Invalid source snapshot entry/);
});

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

test('signing entitlements use Apple-compatible XML bytes across checkouts', () => {
  const xml = fs.readFileSync(path.resolve(__dirname, '../entitlements.plist'), 'utf8');
  assert.ok(xml.startsWith('<?xml'), 'No BOM before the XML declaration');
  assert.ok(!xml.includes('\r'), 'Apple AMFI requires LF line endings');
  assert.ok(!xml.includes('<!--'), 'Apple AMFI does not accept XML comments');
});

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
      `const c=require(${JSON.stringify(config)});console.log(JSON.stringify({rebuild:c.rebuildConfig,sign:c.packagerConfig.osxSign?.optionsForFile('/fixture/CodeBuddy.app/Contents/MacOS/CodeBuddy'),id:c.packagerConfig.appBundleId}));`,
      '--',
      '--platform=darwin',
      '--arch=x64',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        APPLE_TEAM_ID: 'ABCDE12345',
        CODEBUDDY_MAC_SIGN_IDENTITY: 'Developer ID Application: Fixture (ABCDE12345)',
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

test('Forge signing skips non-code resources through the installed signer API', t => {
  const { root } = fixture(t);
  const app = path.join(root, 'Signing.app');
  const native = path.join(app, 'Contents/MacOS/Signing');
  const resource = path.join(app, 'Contents/Resources/locale.pak');
  macho(native, 'arm64');
  fs.mkdirSync(path.dirname(resource), { recursive: true });
  fs.writeFileSync(resource, Buffer.from([5, 0, 0, 0, 0, 0, 0, 0]));
  const result = spawnSync(process.execPath, ['-e', `
    const calls=[];
    const signPath=require.resolve('@electron/osx-sign');
    const util=require(require('node:path').join(require('node:path').dirname(signPath),'util.js'));
    util.execFileAsync=async (command,args)=>{calls.push({command,args});return '';};
    const options=require(${JSON.stringify(path.resolve(__dirname, '../forge.config.ts'))}).packagerConfig.osxSign;
    require('node:assert/strict').equal(options.continueOnError,false,'A signing failure must stop packaging');
    require('@electron/osx-sign').signAsync({...options, app:${JSON.stringify(app)}, platform:'darwin', identityValidation:false})
      .then(()=>console.log(JSON.stringify(calls.filter(c=>c.args.includes('--sign')).map(c=>c.args.at(-1)))))
      .catch(error=>{console.error(error);process.exitCode=1});
  `, '--', '--platform=darwin', '--arch=arm64'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
    env: { ...process.env, CODEBUDDY_MAC_SIGN_IDENTITY: 'Apple Development: Fixture (ABCDE12345)', APPLE_TEAM_ID: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  const signed = JSON.parse(result.stdout);
  assert.ok(signed.includes(native), 'Native code receives a nested signature');
  assert.ok(signed.includes(app), 'Outer application is sealed');
  assert.ok(!signed.includes(resource), 'Ordinary resources must not be signed as code');
});

test('signing requires an explicit compatible identity and reports the actual certificate', () => {
  const { signingPlan, parseSignature } = require('./macos-signing.cjs');
  assert.deepEqual(signingPlan({}), { kind: 'ad-hoc' });
  assert.throws(() => signingPlan({ APPLE_TEAM_ID: 'ABCDE12345' }), /explicitly/);
  assert.throws(() => signingPlan({ CODEBUDDY_MAC_SIGN_IDENTITY: 'Apple Distribution: Fixture (ABCDE12345)' }), /full/);
  const identity = 'Apple Development: Fixture (ABCDE12345)';
  const plan = signingPlan({ CODEBUDDY_MAC_SIGN_IDENTITY: identity });
  assert.equal(plan.kind, 'development');
  assert.equal(plan.notarize, false);
  assert.throws(() => signingPlan({ CODEBUDDY_MAC_SIGN_IDENTITY: identity, APPLE_TEAM_ID: 'ABCDE12345' }), /Developer ID/);
  const output = `Identifier=local.codebuddy.desktop\nAuthority=${identity}\nTeamIdentifier=ABCDE12345\ndesignated => identifier "local.codebuddy.desktop" and anchor apple generic`;
  assert.equal(parseSignature(output, plan).identity, identity);
  assert.throws(() => parseSignature(output.replace('Authority=' + identity, 'Authority=Unexpected'), plan), /differs/);
  assert.equal(parseSignature(output.replace('TeamIdentifier=ABCDE12345', 'TeamIdentifier=OTHER12345'), plan).teamId, 'OTHER12345');
  assert.throws(() => parseSignature(output.replace('TeamIdentifier=ABCDE12345', 'TeamIdentifier=OTHER12345'), { ...plan, teamId: 'ABCDE12345' }), /differs/);
  assert.throws(() => parseSignature('Identifier=local.codebuddy.desktop\nSignature=adhoc\ndesignated => cdhash H"123"', plan), /differs/);
  const adhoc = 'Identifier=local.codebuddy.desktop\nSignature=adhoc\nTeamIdentifier=not set\n# designated => cdhash H"076170dd54b6ea15c01dbb89799ce9d12fef35dd"';
  assert.equal(parseSignature(adhoc, { kind: 'ad-hoc' }).requirement, 'cdhash H"076170dd54b6ea15c01dbb89799ce9d12fef35dd"');
  assert.throws(() => parseSignature(adhoc, plan), /differs/);
  assert.throws(() => parseSignature(adhoc.replace('Signature=adhoc', 'Signature=unknown'), { kind: 'ad-hoc' }), /Expected ad-hoc/);
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
