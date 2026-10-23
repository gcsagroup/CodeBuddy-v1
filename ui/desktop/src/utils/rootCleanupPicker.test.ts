import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { rootCleanupDialogOptions } from './rootCleanupPicker';

const root = path.parse(path.resolve('.')).root;
const stats = (directory: boolean, link = false) => ({
  isDirectory: () => directory,
  isSymbolicLink: () => link,
});

describe('rootCleanupDialogOptions', () => {
  it('allows selecting exactly one file or directory under an explicit root', () => {
    expect(rootCleanupDialogOptions(root, stats(true))).toEqual({
      title: 'Select one exact cleanup target',
      defaultPath: root,
      properties: ['openFile', 'openDirectory'],
    });
  });

  it('rejects relative, non-directory, and link roots', () => {
    expect(() => rootCleanupDialogOptions('relative', stats(true))).toThrow(/absolute/);
    expect(() => rootCleanupDialogOptions(path.join(root, 'file'), stats(false))).toThrow(
      /non-link/
    );
    expect(() => rootCleanupDialogOptions(path.join(root, 'link'), stats(true, true))).toThrow(
      /non-link/
    );
  });
});
