import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listGitWorktreeDirs } from './workspaceOperations';

const tempDirectories: string[] = [];

function git(repository: string, args: string[]): string {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe('listGitWorktreeDirs', () => {
  it('returns an empty list for an empty or non-git directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codepro-worktree-list-'));
    tempDirectories.push(root);

    await expect(listGitWorktreeDirs('')).resolves.toEqual([]);
    await expect(listGitWorktreeDirs(root)).resolves.toEqual([]);
  });

  it('lists the repository and its registered worktrees once', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codepro-worktree-list-'));
    tempDirectories.push(root);
    const source = path.join(root, 'source');
    const worktree = path.join(root, 'secondary');
    await mkdir(source);
    git(source, ['init']);
    git(source, ['config', 'user.name', 'CodePro Test']);
    git(source, ['config', 'user.email', 'codepro-test@example.invalid']);
    await writeFile(path.join(source, 'app.txt'), 'before\n');
    git(source, ['add', 'app.txt']);
    git(source, ['commit', '-m', 'baseline']);
    git(source, ['worktree', 'add', '--detach', worktree, 'HEAD']);

    const directories = await listGitWorktreeDirs(source);

    expect(directories.map(path.normalize)).toEqual([
      path.normalize(await realpath(source)),
      path.normalize(await realpath(worktree)),
    ]);
  });
});
