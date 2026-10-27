import { expect, it, vi } from 'vitest';
import { syncBundledExtensions } from './bundled-extensions';
import type { FixedExtensionEntry } from '../../ConfigContext';

it('enables computer control for a fresh desktop profile', async () => {
  const add = vi.fn().mockResolvedValue(undefined);
  await syncBundledExtensions([], add);
  expect(add).toHaveBeenCalledWith(
    'qwen_computer',
    expect.objectContaining({ type: 'builtin', name: 'qwen_computer' }),
    true
  );
});

it('keeps an existing explicit disabled computer-control choice', async () => {
  const add = vi.fn().mockResolvedValue(undefined);
  const existing: FixedExtensionEntry = {
    type: 'builtin', name: 'qwen_computer', description: '', enabled: false, bundled: true,
  };
  await syncBundledExtensions([existing], add);
  expect(add).not.toHaveBeenCalledWith('qwen_computer', expect.anything(), expect.anything());
  expect(existing.enabled).toBe(false);
});
