'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { distributionTarget, assertOfficeTarget } = require('./stage-harness-distribution.cjs');
const { verifyHarnessBundle } = require('../ui/desktop/scripts/bundle-macos.cjs');
const { writeMacArtifacts, verifyMacArtifacts, macSigningOptionsForFile, ignoreNonMacCode } = require('./macos-tool-artifacts.cjs');
const { macArtifactFiles } = require('../runtime/builtin-artifacts.mjs');

function binary(file, arch) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
  fs.writeFileSync(file, bytes, { mode: 0o755 });
}

for (const arch of ['arm64', 'x64']) {
  test(`${arch}: accepts native Harness resources and rejects mixed payloads`, t => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-harness-mac-'));
    t.after(() => {
      assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(temporary).startsWith('codebuddy-harness-mac-'));
      fs.rmSync(temporary, { recursive: true, force: true });
    });
    const app = path.join(temporary, 'CodeBuddy.app');
    const resources = path.join(app, 'Contents/Resources');
    const root = path.join(resources, 'harness-distribution');
    const manifestPath = path.join(root, 'manifest.json');
    const officePath = path.join(root, 'runtime/py/runtime.json');
    const manifest = JSON.stringify({ schemaVersion: 1, engine: 'deepseek-harness', files: [] });
    binary(path.join(root, 'node/node'), arch);
    fs.mkdirSync(path.dirname(officePath), { recursive: true });
    fs.writeFileSync(officePath, JSON.stringify({ platform: 'darwin', arch }));
    fs.writeFileSync(manifestPath, manifest);
    const pty = path.join(resources, `app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-${arch}`);
    binary(path.join(pty, 'pty.node'), arch);
    binary(path.join(pty, 'spawn-helper'), arch);
    const tools = path.join(root, 'runtime/tools');
    for (const file of Object.values(macArtifactFiles)) binary(path.join(tools, 'bin', file), arch);
    assert.equal(ignoreNonMacCode(path.join(tools, 'bin/qwen-computer-runtime')), false);
    const foreign = path.join(temporary, 'foreign.node');
    fs.writeFileSync(foreign, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    assert.equal(ignoreNonMacCode(foreign), true);
    assert.equal(ignoreNonMacCode(app), false);
    writeMacArtifacts(tools, arch, { revision: 'fixture', dirty: true });
    assert.equal(verifyHarnessBundle(app, arch, manifest), root);
    assert.throws(() => verifyHarnessBundle(app, arch, manifest, 'signed'), /Expected signed/);
    // Simulate a signer changing a child's bytes before sealing the outer app.
    fs.appendFileSync(path.join(tools, 'bin/qwen-computer-runtime'), 'signature fixture');
    assert.throws(() => verifyMacArtifacts(tools, arch), /identity differs/);
    macSigningOptionsForFile(app, '/fixture/entitlements.plist', false);
    const signed = verifyMacArtifacts(tools, arch, 'signed');
    assert.notEqual(signed.artifacts.helper.sha256, signed.sourceArtifacts.helper.sha256);
    assert.equal(verifyHarnessBundle(app, arch, manifest, 'signed'), root);
    fs.unlinkSync(path.join(tools, 'bin/qwen-computer-runtime'));
    assert.throws(() => verifyHarnessBundle(app, arch), /ENOENT/);
    binary(path.join(tools, 'bin/qwen-computer-runtime'), arch);
    writeMacArtifacts(tools, arch, { revision: 'fixture', dirty: true });
    assert.throws(() => verifyHarnessBundle(app, arch, '{}'), /differs/);
    fs.writeFileSync(officePath, JSON.stringify({ platform: 'win32', arch: 'x64' }));
    assert.throws(() => verifyHarnessBundle(app, arch), /Office payload/);
    fs.writeFileSync(officePath, JSON.stringify({ platform: 'darwin', arch }));
    binary(path.join(root, 'node/node'), arch === 'arm64' ? 'x64' : 'arm64');
    assert.throws(() => verifyHarnessBundle(app, arch), /Mach-O/);
    binary(path.join(root, 'node/node'), arch);
    fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, engine: 'deepseek-harness', files: [{ path: 'runtime/tools/bin/codebuddy-tools.exe' }] }));
    assert.throws(() => verifyHarnessBundle(app, arch), /Unexpected executable/);
    fs.writeFileSync(manifestPath, manifest);
    fs.unlinkSync(path.join(pty, 'spawn-helper'));
    assert.throws(() => verifyHarnessBundle(app, arch), /ENOENT/);
  });
}

test('Office staging requires the host platform and architecture', () => {
  assert.deepEqual(distributionTarget('darwin', 'arm64'), { node: 'node', office: 'mac-arm64' });
  assert.deepEqual(distributionTarget('darwin', 'x64'), { node: 'node', office: 'mac-x64' });
  assert.deepEqual(distributionTarget('win32', 'x64'), { node: 'node.exe', office: 'win-x64' });
  assert.throws(() => distributionTarget('darwin', 'universal'), /Unsupported/);
  assert.throws(() => assertOfficeTarget({ platform: 'win32', arch: 'x64' }, 'darwin', 'arm64'), /does not match/);
  assert.throws(() => assertOfficeTarget({ platform: 'darwin', arch: 'x64' }, 'darwin', 'arm64'), /does not match/);
  assert.doesNotThrow(() => assertOfficeTarget({ platform: 'darwin', arch: 'arm64' }, 'darwin', 'arm64'));
});
