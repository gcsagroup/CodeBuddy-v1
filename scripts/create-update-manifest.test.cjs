const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createManifest } = require('./create-update-manifest.cjs');

test('release manifest binds each platform to actual package bytes and rejects ambiguous targets', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-update-manifest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from('isolated package fixture');
  const file = path.join(root, 'CodeBuddy-1.43.10.exe');
  fs.writeFileSync(file, bytes);
  const input = { platform: 'win32', arch: 'x64', file };
  const result = createManifest('1.43.10', [input]);
  assert.deepEqual(result, { schemaVersion: 1, version: '1.43.10', artifacts: [{ platform: 'win32', arch: 'x64', name: path.basename(file), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] });
  assert.throws(() => createManifest('1.43.10', [input, input]), /Duplicate/);
  assert.throws(() => createManifest('1.43.10', [{ ...input, platform: 'darwin' }]), /ZIP/);
  assert.throws(() => createManifest('garbage', [input]), /version/);
  fs.writeFileSync(file, '');
  assert.throws(() => createManifest('1.43.10', [input]), /Empty/);
});
