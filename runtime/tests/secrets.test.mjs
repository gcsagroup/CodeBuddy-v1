import test from 'node:test';
import assert from 'node:assert/strict';
import { protectSecret, revealSecret } from '../secrets.mjs';

test('Windows credential storage round-trips Unicode and whitespace without normalization', { skip: process.platform !== 'win32' }, async () => {
  for (const value of ['fixture-ascii', '本机隔离 MCP 使用统计验收；只读随机标记。', '繁體描述 🔑 café', '  fixture\r\nsecond line\t ']) {
    const protectedValue = await protectSecret(value);
    assert.equal(protectedValue.kind, 'windows-dpapi');
    assert.equal(await revealSecret(protectedValue), value);
  }
});
