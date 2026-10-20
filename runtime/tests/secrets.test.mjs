import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { protectSecret, revealSecret } from '../secrets.mjs';

test('native credential storage round-trips Unicode and whitespace without normalization', { skip: !['win32', 'darwin'].includes(process.platform) }, async () => {
  for (const value of ['fixture-ascii', '本机隔离 MCP 使用统计验收；只读随机标记。', '繁體描述 🔑 café', '  fixture\r\nsecond line\t ']) {
    const protectedValue = await protectSecret(value);
    assert.equal(protectedValue.kind, process.platform === 'darwin' ? 'macos-keychain-aesgcm-v1' : 'windows-dpapi');
    assert.equal(await revealSecret(protectedValue), value);
  }
});

test('credential envelopes reject foreign platforms and tampering', { skip: !['win32', 'darwin'].includes(process.platform) }, async () => {
  const original = await protectSecret('fixture-secret-only');
  const bytes = Buffer.from(original.ciphertext, 'base64');
  bytes[bytes.length - 1] ^= 1;
  await assert.rejects(revealSecret({ ...original, ciphertext: bytes.toString('base64') }));
  await assert.rejects(revealSecret({ ...original, kind: process.platform === 'darwin' ? 'windows-dpapi' : 'macos-keychain-aesgcm-v1' }), /another platform/);
  assert.equal(await revealSecret(original), 'fixture-secret-only');
});

test('Mac Keychain remains bound to the OS account when tool HOME is isolated', { skip: process.platform !== 'darwin' }, async () => {
  const previous = process.env.HOME;
  const isolated = await mkdtemp(path.join(tmpdir(), 'credential-home-'));
  try {
    const original = await protectSecret('fixture-before-home-isolation');
    process.env.HOME = isolated;
    assert.equal(await revealSecret(original), 'fixture-before-home-isolation');
    const inside = await protectSecret('fixture-inside-home-isolation');
    assert.equal(await revealSecret(inside), 'fixture-inside-home-isolation');
    assert.equal(process.env.HOME, isolated);
  } finally {
    previous === undefined ? delete process.env.HOME : process.env.HOME = previous;
    await rm(isolated, { recursive: true, force: true });
  }
});
