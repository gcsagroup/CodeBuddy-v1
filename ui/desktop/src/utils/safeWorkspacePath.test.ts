import { describe, expect, it } from 'vitest';
import { resolveWorkspaceFilePath } from './safeWorkspacePath';

describe('resolveWorkspaceFilePath', () => {
  it('resolves files inside the workspace', () => {
    expect(resolveWorkspaceFilePath('D:\\project', 'docs\\guide.md')).toBe(
      'D:\\project\\docs\\guide.md'
    );
  });

  it('rejects parent traversal and absolute paths outside the workspace', () => {
    expect(() => resolveWorkspaceFilePath('D:\\project', '..\\secret.txt')).toThrow(
      '不在当前工作目录内'
    );
    expect(() => resolveWorkspaceFilePath('D:\\project', 'C:\\secret.txt')).toThrow(
      '不在当前工作目录内'
    );
  });
});
