import path from 'node:path';

export function resolveWorkspaceFilePath(workspaceRoot: string, requestedPath: string): string {
  const root = path.resolve(workspaceRoot);
  const candidate = path.resolve(root, requestedPath);
  const relative = path.relative(root, candidate);

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    if (!relative) return candidate;
    throw new Error('请求的文件不在当前工作目录内');
  }

  return candidate;
}
