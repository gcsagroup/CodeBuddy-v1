import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';

interface GitCommandOptions {
  env?: Record<string, string | undefined>;
  timeout?: number;
}

export interface WorkingTreeSnapshot {
  tree: string;
}

export function execGitText(
  args: string[],
  { env, timeout = 10_000 }: GitCommandOptions = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        env: env ? { ...process.env, ...env } : process.env,
        maxBuffer: 2 * 1024 * 1024,
        timeout,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

export async function createWorkingTreeSnapshot(
  sourceRoot: string,
  temporaryDirectory: string
): Promise<WorkingTreeSnapshot> {
  const indexPath = path.join(temporaryDirectory, `.codepro-index-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: indexPath };

  try {
    await execGitText(['-C', sourceRoot, 'read-tree', 'HEAD'], { env });
    await execGitText(['-C', sourceRoot, 'add', '-A', '--'], {
      env,
      timeout: 30_000,
    });
    const tree = await execGitText(['-C', sourceRoot, 'write-tree'], { env });
    return { tree: tree.trim() };
  } finally {
    await rm(indexPath, { force: true });
  }
}
