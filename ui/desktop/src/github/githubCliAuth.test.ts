import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { GitHubCliLogin, githubCliLogout, githubCliStatus } from './githubCliAuth';
vi.mock('node:child_process', () => {
  const mock = { execFile: vi.fn(), spawn: vi.fn() };
  return { ...mock, default: mock };
});
function commandResults(results: Array<string | Error>) {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args[3] as (error: Error | null, stdout: string) => void;
    const result = results.shift();
    callback(result instanceof Error ? result : null, typeof result === 'string' ? result : '');
    return {} as ReturnType<typeof execFile>;
  });
}
function child() {
  const result = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(result as unknown as ReturnType<typeof spawn>);
  return result;
}
describe('GitHub CLI account connection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('GH_TOKEN', '');
    vi.stubEnv('GITHUB_TOKEN', '');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
  it('signs out only the confirmed account and reads the resulting state', async () => {
    commandResults([
      '{"hosts":{"github.com":[{"active":true,"login":"octocat"}]}}',
      '',
      'gh',
      '{"hosts":{}}',
    ]);
    expect(await githubCliLogout('octocat')).toEqual({ state: 'disconnected' });
    expect(vi.mocked(execFile).mock.calls[1][1]).toEqual([
      'auth',
      'logout',
      '--hostname',
      'github.com',
      '--user',
      'octocat',
    ]);
  });
  it('preserves another account selected by the CLI after logout', async () => {
    commandResults([
      '{"hosts":{"github.com":[{"active":true,"login":"octocat"}]}}',
      '',
      'gh',
      '{"hosts":{"github.com":[{"active":true,"state":"success","login":"other"}]}}',
    ]);
    expect(await githubCliLogout('octocat')).toEqual({ state: 'connected', login: 'other' });
  });
  it('rejects malformed, changed and environment-managed accounts without logging out', async () => {
    await expect(githubCliLogout('--all')).rejects.toThrow('Invalid');
    commandResults(['{"hosts":{"github.com":[{"active":true,"login":"other"}]}}']);
    await expect(githubCliLogout('octocat')).rejects.toThrow('changed');
    vi.stubEnv('GH_TOKEN', 'test-environment-value');
    await expect(githubCliLogout('octocat')).rejects.toThrow('environment');
    expect(execFile).toHaveBeenCalledTimes(1);
  });
  it('reports failed logout and releases the authentication lock for retry', async () => {
    const accounts = '{"hosts":{"github.com":[{"active":true,"login":"octocat"}]}}';
    commandResults([accounts, new Error('private error')]);
    await expect(githubCliLogout('octocat')).rejects.toThrow('GitHub CLI request failed');
    commandResults([accounts, '', 'gh', '{"hosts":{}}']);
    expect(await githubCliLogout('octocat')).toEqual({ state: 'disconnected' });
  });
  it('shares an in-flight verified status and returns only the identity without a second API request', async () => {
    commandResults([
      'gh 2.96',
      '{"hosts":{"github.com":[{"active":true,"state":"success","login":"octocat","token":"must-not-escape"}]}}',
    ]);
    const first = githubCliStatus();
    expect(githubCliStatus()).toBe(first);
    expect(await first).toEqual({ state: 'connected', login: 'octocat' });
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(vi.mocked(execFile).mock.calls[1][1]).toEqual([
      'auth',
      'status',
      '--hostname',
      'github.com',
      '--json',
      'hosts',
    ]);
    commandResults(['gh', '{"hosts":{}}']);
    expect(await githubCliStatus()).toEqual({ state: 'disconnected' });
  });
  it('distinguishes a missing installation, signed-out account, and network failure', async () => {
    commandResults([new Error('missing')]);
    expect(await githubCliStatus()).toEqual({ state: 'unavailable' });
    commandResults(['gh', '{"hosts":{}}']);
    expect(await githubCliStatus()).toEqual({ state: 'disconnected' });
    commandResults(['gh', new Error('network')]);
    expect(await githubCliStatus()).toEqual({ state: 'check_failed' });
  });
  it.each([
    { active: true, state: 'error', login: 'octocat' },
    { active: true, login: 'octocat' },
    { active: true, state: 'success', login: '<script>' },
  ])(
    'does not report a JSON-mode failed or malformed account as connected: %j',
    async (account) => {
      commandResults(['gh', JSON.stringify({ hosts: { 'github.com': [account] } })]);
      expect(await githubCliStatus()).toEqual({ state: 'check_failed' });
    }
  );
  it('handles split device-code output, cancels only its owned process and rejects stale polls', async () => {
    const process = child();
    const login = new GitHubCliLogin();
    const pending = login.start();
    process.stderr.write('! First copy your one-time code: ABCD-');
    process.stderr.write('EFGH\n');
    const challenge = await pending;
    expect(challenge.userCode).toBe('ABCD-EFGH');
    await expect(login.start()).rejects.toThrow('already active');
    expect(await login.poll(challenge.flowId)).toEqual({ state: 'pending' });
    login.cancel('wrong-id');
    expect(process.kill).not.toHaveBeenCalled();
    login.cancel(challenge.flowId);
    expect(process.kill).toHaveBeenCalledOnce();
    process.emit('close', null);
    await expect(login.poll(challenge.flowId)).rejects.toThrow('not found');
  });
  it('requires successful process exit and a fresh identity check after authorization', async () => {
    const process = child();
    const login = new GitHubCliLogin();
    const pending = login.start();
    process.stderr.write('! First copy your one-time code: ABCD-EFGH\n');
    const challenge = await pending;
    process.emit('close', 0);
    commandResults(['gh', new Error('network')]);
    expect(await login.poll(challenge.flowId)).toEqual({ state: 'failed' });
  });
  it('bounds startup waiting and never forwards stderr to the renderer', async () => {
    vi.useFakeTimers();
    const process = child();
    const login = new GitHubCliLogin();
    const pending = expect(login.start()).rejects.toThrow('GitHub sign-in did not start');
    process.stderr.write('private diagnostic');
    await vi.advanceTimersByTimeAsync(30000);
    await pending;
    expect(process.kill).toHaveBeenCalledOnce();
    process.emit('close', null);
  });
});
