import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { resolveWorkspaceFilePath } from './safeWorkspacePath';

const root = path.resolve('fixture-project');

describe('resolveWorkspaceFilePath', () => {
  it('resolves files inside the workspace', () => {
    expect(resolveWorkspaceFilePath(root, path.join('docs', 'guide.md'))).toBe(
      path.join(root, 'docs', 'guide.md')
    );
  });

  it('rejects parent traversal and absolute paths outside the workspace', () => {
    expect(() => resolveWorkspaceFilePath(root, path.join('..', 'secret.txt'))).toThrow(
      '不在当前工作目录内'
    );
    expect(() => resolveWorkspaceFilePath(root, path.resolve(root, '..', 'secret.txt'))).toThrow(
      '不在当前工作目录内'
    );
  });
});
