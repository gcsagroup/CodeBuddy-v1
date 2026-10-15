import { describe, expect, it } from 'vitest';
import { rootCleanupDialogOptions } from './rootCleanupPicker';

const stats = (directory: boolean, link = false) => ({
  isDirectory: () => directory,
  isSymbolicLink: () => link,
});

describe('rootCleanupDialogOptions', () => {
  it('allows selecting exactly one file or directory under an explicit root', () => {
    expect(rootCleanupDialogOptions('D:\\', stats(true))).toEqual({
      title: 'Select one exact cleanup target',
      defaultPath: 'D:\\',
      properties: ['openFile', 'openDirectory'],
    });
  });

  it('rejects relative, non-directory, and link roots', () => {
    expect(() => rootCleanupDialogOptions('relative', stats(true))).toThrow(/absolute/);
    expect(() => rootCleanupDialogOptions('D:\\file', stats(false))).toThrow(/non-link/);
    expect(() => rootCleanupDialogOptions('D:\\link', stats(true, true))).toThrow(/non-link/);
  });
});
