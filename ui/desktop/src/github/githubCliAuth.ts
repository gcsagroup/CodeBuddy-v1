import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GitHubCliChallenge, GitHubCliPoll, GitHubCliStatus } from './githubCliTypes';

const LIMIT = 64 * 1024;
const LOGIN_TIMEOUT = 15 * 60 * 1000;
export function githubCliExecutable(): string {
  const candidates =
    process.platform === 'win32'
      ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe')]
      : ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'];
  return candidates.find(existsSync) || 'gh';
}
function cliEnvironment(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    GH_PROMPT_DISABLED: '1',
    NO_COLOR: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
  };
  // Inherited debug modes could print HTTP credentials into child output.
  delete env.GH_DEBUG;
  delete env.GH_FORCE_TTY;
  return env;
}
function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      githubCliExecutable(),
      args,
      { env: cliEnvironment(), windowsHide: true, timeout: 20000, maxBuffer: LIMIT },
      (error, stdout) => (error ? reject(new Error('GitHub CLI request failed')) : resolve(stdout))
    );
  });
}
// Update downloads use the user's existing account without copying its token
// into product settings, IPC responses, logs, or the distribution package.
export async function githubUpdateCredential(): Promise<{ login: string; token: string }> {
  const status = await githubCliStatus();
  if (status.state !== 'connected' || !status.login)
    throw new Error('请先在“账号与凭据”连接 GitHub，再检查更新。');
  const token = (
    await run(['auth', 'token', '--hostname', 'github.com', '--user', status.login])
  ).trim();
  if (!token || /\s/.test(token)) throw new Error('GitHub 登录已过期，请重新连接。');
  return { login: status.login, token };
}
export function parseDeviceCode(output: string): string | undefined {
  return /First copy your one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})(?:\r?\n|$)/.exec(output)?.[1];
}
let statusCheck: Promise<GitHubCliStatus> | undefined;
export function githubCliStatus(): Promise<GitHubCliStatus> {
  // Share in-flight checks (including React remounts), never cache authentication results.
  if (statusCheck) return statusCheck;
  const check = inspectGitHubCliStatus().finally(() => {
    if (statusCheck === check) statusCheck = undefined;
  });
  statusCheck = check;
  return check;
}
async function inspectGitHubCliStatus(): Promise<GitHubCliStatus> {
  try {
    await run(['--version']);
  } catch {
    return { state: 'unavailable' };
  }
  try {
    const response = JSON.parse(
      await run(['auth', 'status', '--hostname', 'github.com', '--json', 'hosts'])
    );
    const accounts = response.hosts?.['github.com'] ?? (response.hosts ? [] : undefined);
    if (!Array.isArray(accounts)) throw new Error('Invalid status');
    const active = accounts.find((account: { active?: boolean }) => account.active === true);
    if (!active) return { state: 'disconnected' };
    // gh auth status already verifies the account online. JSON mode exits 0 even
    // on auth errors, so consume its structured state rather than exit code alone.
    if (
      active.state !== 'success' ||
      typeof active.login !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(active.login)
    ) {
      return { state: 'check_failed' };
    }
    return { state: 'connected', login: active.login };
  } catch {
    return { state: 'check_failed' };
  }
}
type Flow = {
  child: ChildProcess;
  timer: ReturnType<typeof setTimeout>;
  result: 'pending' | 'done' | 'failed';
  challenge?: GitHubCliChallenge;
  cancel: () => void;
};
let activeChild: ChildProcess | undefined;
let signingOut = false;

export async function githubCliLogout(login: unknown): Promise<GitHubCliStatus> {
  if (typeof login !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(login)) {
    throw new Error('Invalid GitHub account');
  }
  if (activeChild || signingOut) throw new Error('GitHub authentication is already active');
  signingOut = true;
  try {
    // Environment credentials are owned by the launching process, not by gh's keychain.
    if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
      throw new Error('GitHub authentication is managed by the environment');
    }
    const response = JSON.parse(
      await run(['auth', 'status', '--hostname', 'github.com', '--json', 'hosts'])
    );
    const accounts = response.hosts?.['github.com'];
    if (
      !Array.isArray(accounts) ||
      !accounts.some((account) => account.active && account.login === login)
    ) {
      throw new Error('GitHub account changed; refresh before signing out');
    }
    await run(['auth', 'logout', '--hostname', 'github.com', '--user', login]);
    // gh may select another saved account after logout; show its actual state.
    statusCheck = undefined;
    return await githubCliStatus();
  } finally {
    signingOut = false;
  }
}

export class GitHubCliLogin {
  private flow?: Flow;
  async start(): Promise<GitHubCliChallenge> {
    if (this.flow || activeChild || signingOut) throw new Error('GitHub login is already active');
    const child = spawn(
      githubCliExecutable(),
      [
        'auth',
        'login',
        '--hostname',
        'github.com',
        '--web',
        '--git-protocol',
        'https',
        '--skip-ssh-key',
      ],
      { env: cliEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    activeChild = child;
    return new Promise((resolve, reject) => {
      let output = '';
      let settled = false;
      const fail = () => {
        if (!settled) {
          settled = true;
          reject(new Error('GitHub sign-in did not start. Check the network and GitHub CLI.'));
        }
      };
      const timer = setTimeout(() => {
        flow.result = 'failed';
        child.kill();
        fail();
      }, LOGIN_TIMEOUT);
      const startTimer = setTimeout(() => {
        flow.result = 'failed';
        child.kill();
        fail();
      }, 30000);
      const flow: Flow = { child, timer, result: 'pending', cancel: fail };
      this.flow = flow;
      child.stdout.on('data', () => undefined);
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (Buffer.byteLength(output) > LIMIT) {
          flow.result = 'failed';
          child.kill();
          fail();
          return;
        }
        const code = parseDeviceCode(output);
        if (code && !settled) {
          settled = true;
          clearTimeout(startTimer);
          flow.challenge = {
            flowId: randomUUID(),
            userCode: code,
            expiresAt: Date.now() + LOGIN_TIMEOUT,
          };
          resolve(flow.challenge);
        }
      });
      const finish = (success: boolean) => {
        clearTimeout(timer);
        clearTimeout(startTimer);
        if (activeChild === child) activeChild = undefined;
        flow.result = success && flow.result !== 'failed' ? 'done' : 'failed';
        fail();
        if (!flow.challenge && this.flow === flow) this.flow = undefined;
      };
      child.once('error', () => finish(false));
      child.once('close', (code) => finish(code === 0));
    });
  }
  async poll(flowId: string): Promise<GitHubCliPoll> {
    const flow = this.flow;
    if (!flow || flow.challenge?.flowId !== flowId) throw new Error('GitHub login flow not found');
    if (flow.result === 'pending') return { state: 'pending' };
    if (flow.result === 'failed') {
      this.flow = undefined;
      return { state: 'failed' };
    }
    statusCheck = undefined;
    const status = await githubCliStatus();
    if (this.flow !== flow) throw new Error('GitHub login was cancelled');
    this.flow = undefined;
    return status.state === 'connected'
      ? { state: 'connected', login: status.login }
      : { state: 'failed' };
  }
  cancel(flowId?: string): void {
    const flow = this.flow;
    if (!flow || (flowId && flow.challenge?.flowId !== flowId)) return;
    clearTimeout(flow.timer);
    flow.result = 'failed';
    flow.cancel();
    flow.child.kill();
    this.flow = undefined;
    if (activeChild === flow.child) activeChild = undefined;
  }
}
