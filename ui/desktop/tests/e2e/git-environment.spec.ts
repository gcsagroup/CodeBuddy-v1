import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { expect, test } from './fixtures';

const workspace = mkdtempSync(join(tmpdir(), 'codebuddy-git-path-e2e-'));
// Strip only Git entries: the development launcher still needs its existing
// package-manager commands. This does not install or change any dependency.
const stalePath = [dirname(process.execPath), ...(process.env.Path ?? process.env.PATH ?? '').split(delimiter)]
  .filter(directory => directory && !['git.exe', 'git.cmd', 'git.bat', 'git.com'].some(file => existsSync(join(directory, file)))).join(delimiter);
test.use({ initialWorkingDir: workspace, commandPathOverride: process.platform === 'win32'
  ? stalePath : undefined });
test.setTimeout(240_000);

function git(...args: string[]) {
  return execFileSync('git', args, { cwd: workspace, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
test.beforeAll(() => {
  git('init', '-b', 'main');
  git('config', 'user.name', 'Git environment acceptance');
  git('config', 'user.email', 'git-environment@example.invalid');
  git('config', 'core.hooksPath', join(workspace, 'no-hooks'));
  writeFileSync(join(workspace, 'calculator.py'), 'print(1 + 1)\n');
  git('add', '--', 'calculator.py');
});

test('Git lookup recovers a stale application PATH and commits a staged fixture through the desktop', async ({ appPage, isolatedProfileRoot }, info) => {
  await appPage.evaluate(dir => window.electron.addRecentDir(dir), workspace);
  await appPage.getByRole('button', { name: '选择项目', exact: true }).click();
  await appPage.getByRole('menuitem').filter({ hasText: basename(workspace) }).click();
  const trust = appPage.getByRole('button', { name: '使用这个文件夹', exact: true });
  if (await trust.isVisible()) await trust.click();
  await appPage.getByTestId('chat-input').fill('只验收当前临时项目的 Git：用命令检查 git --version 和 git status，然后提交已经暂存的 calculator.py，提交说明必须是 test: verify Git environment discovery。不要修改 PATH，不要使用 Git 绝对路径，不要下载或安装，不要新建分支，不要联网或推送。完成后用 git status 验证并简短报告版本和提交结果。');
  await appPage.getByTestId('chat-input').press('Enter');
  await expect.poll(() => new URL(appPage.url()).hash).toContain('resumeSessionId');
  // Current Harness uses its configured provider. Validate the repository result,
  // not a hard-coded response from the retired deterministic provider adapter.
  await expect.poll(async () => {
    const allow = appPage.getByRole('button', { name: '仅此次允许', exact: true }).first();
    if (await allow.isVisible()) await allow.click();
    try { return git('log', '-1', '--format=%s'); } catch { return ''; }
  }, { timeout: 150_000, intervals: [1000, 2000, 5000] }).toBe('test: verify Git environment discovery');
  expect(git('status', '--porcelain')).toBe('');
  await expect(appPage.getByText(/2\.\d+\.\d+/).last()).toBeVisible({ timeout: 30000 });
  await expect(appPage.getByRole('button', { name: '停止', exact: true })).toHaveCount(0, { timeout: 30000 });
  const state = JSON.parse(readFileSync(join(isolatedProfileRoot, '.CodeBuddy', 'backend', 'state.json'), 'utf8'));
  const session = state.sessions.find((item: { cwd: string }) => item.cwd === workspace);
  expect(session).toBeTruthy();
  const evidence = info.outputPath('git-result.json');
  writeFileSync(evidence, JSON.stringify({ workspace, sessionId: session.id, updates: session.updates, commit: git('log', '-1', '--format=%H %s'), status: git('status', '--porcelain'), visible: await appPage.locator('body').innerText() }, null, 2));
  await info.attach('git-result', { path: evidence, contentType: 'application/json' });
  await appPage.screenshot({ path: info.outputPath('git-path-commit.png') });
});
