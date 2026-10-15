import { execFile } from 'node:child_process';

export function listGitWorktreeDirs(dir: string): Promise<string[]> {
  return new Promise((resolve) => {
    if (!dir?.trim()) {
      resolve([]);
      return;
    }

    execFile(
      'git',
      ['-C', dir, 'worktree', 'list', '--porcelain'],
      { timeout: 3000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }

        resolve(
          stdout
            .split('\n')
            .filter((line) => line.startsWith('worktree '))
            .map((line) => line.slice('worktree '.length).trim())
            .filter(Boolean)
            .filter((worktreeDir, index, allDirs) => allDirs.indexOf(worktreeDir) === index)
        );
      }
    );
  });
}
