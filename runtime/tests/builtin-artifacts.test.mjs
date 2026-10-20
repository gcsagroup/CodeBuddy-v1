import assert from 'node:assert/strict';
import test from 'node:test';
import { builtinArtifacts, parseMacArtifacts, macArtifactFiles } from '../builtin-artifacts.mjs';

function fixture(arch = 'arm64') {
  return { schemaVersion: 1, platform: 'darwin', arch, phase: 'staged',
    artifacts: Object.fromEntries(Object.entries(macArtifactFiles).map(([key, file]) =>
      [key, { file, bytes: 1234, sha256: 'a'.repeat(64) }])) };
}

test('Mac artifact registry requires all fixed native binaries', () => {
  for (const arch of ['arm64', 'x64']) {
    const value = fixture(arch);
    assert.deepEqual(Object.keys(parseMacArtifacts(value, arch)).sort(), ['computer', 'credentials', 'helper', 'tools']);
    value.phase = 'signed';
    assert.equal(parseMacArtifacts(value, arch).helper.file, 'qwen-computer-runtime');
    delete value.artifacts.helper;
    assert.throws(() => parseMacArtifacts(value, arch), /identity/);
  }
});

test('Mac identities reject path substitution, target mismatch and malformed hashes', () => {
  for (const [key, changed] of [
    ['file', '../qwen-computer-runtime'], ['file', '/tmp/tool'], ['file', 'codebuddy-tools.exe'],
    ['bytes', -1], ['bytes', 1.5], ['sha256', 'not-a-digest'], ['sha256', null],
  ]) {
    const value = fixture();
    value.artifacts.helper[key] = changed;
    assert.throws(() => parseMacArtifacts(value, 'arm64'), /identity/);
  }
  assert.throws(() => parseMacArtifacts(fixture('x64'), 'arm64'), /manifest/);
  assert.throws(() => parseMacArtifacts({ ...fixture(), platform: 'win32' }, 'arm64'), /manifest/);
  assert.throws(() => parseMacArtifacts({ ...fixture(), phase: 'unknown' }, 'arm64'), /manifest/);
  assert.throws(() => parseMacArtifacts(fixture(), 'universal'), /manifest/);
});

test('Windows retains pinned executable identities; unsupported targets stay unavailable', async () => {
  const windows = await builtinArtifacts('win32', 'x64');
  assert.equal(windows.tools.file, 'codebuddy-tools.exe');
  assert.equal(windows.computer.file, 'qwen-computer-use.exe');
  await assert.rejects(builtinArtifacts('linux', 'arm64'), /not been supplied/);
});
