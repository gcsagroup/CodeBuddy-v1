import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkingTreeSnapshot } from './gitSnapshot';

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

describe('createWorkingTreeSnapshot', () => {
  it('captures tracked and untracked changes without modifying the source index', async () => {
    const repository = await mkdtemp(path.join(tmpdir(), 'codepro-snapshot-'));
    tempDirectories.push(repository);
    git(repository, ['init']);
    git(repository, ['config', 'user.name', 'CodePro Test']);
    git(repository, ['config', 'user.email', 'codepro-test@example.invalid']);
    await writeFile(path.join(repository, 'README.md'), 'baseline\n');
    git(repository, ['add', 'README.md']);
    git(repository, ['commit', '-m', 'baseline']);

    await writeFile(path.join(repository, 'README.md'), 'changed\n');
    await writeFile(path.join(repository, 'new-file.txt'), 'untracked\n');
    const statusBefore = git(repository, ['status', '--porcelain', '--untracked-files=normal']);

    const snapshot = await createWorkingTreeSnapshot(repository, repository);

    expect(git(repository, ['status', '--porcelain', '--untracked-files=normal'])).toBe(
      statusBefore
    );
    expect(snapshot.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(await readFile(path.join(repository, 'README.md'), 'utf8')).toBe('changed\n');
    expect(await readFile(path.join(repository, 'new-file.txt'), 'utf8')).toBe('untracked\n');
  });
});
