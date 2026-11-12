import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './fixtures';

const workspace = join(tmpdir(), 'codepro-review-center-e2e');

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
}

function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function repositoryEvidence() {
  return {
    head: git('rev-parse', 'HEAD'),
    index: hash(join(workspace, '.git', 'index')),
    status: git('status', '--porcelain=v1', '--untracked-files=all'),
    review: hash(join(workspace, 'src', 'review.ts')),
    staged: hash(join(workspace, 'src', 'staged.ts')),
    branch: hash(join(workspace, 'src', 'branch.ts')),
  };
}

test.use({ initialWorkingDir: workspace });
test.setTimeout(480_000);

test.beforeAll(() => {
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(join(workspace, 'package.json'), '{"type":"module"}\n', 'utf8');
  writeFileSync(join(workspace, 'src', 'review.ts'), 'export const review = "base";\n', 'utf8');
  writeFileSync(join(workspace, 'src', 'staged.ts'), 'export const staged = "base";\n', 'utf8');
  writeFileSync(join(workspace, 'src', 'branch.ts'), 'export const branch = "base";\n', 'utf8');
  git('init', '-b', 'main');
  git('config', 'user.email', 'codepro-e2e@example.invalid');
  git('config', 'user.name', 'CodePro E2E');
  git('add', '.');
  git('commit', '-m', 'base');
  git('branch', 'comparison');
  writeFileSync(join(workspace, 'src', 'branch.ts'), 'export const branch = "changed";\n', 'utf8');
  git('add', 'src/branch.ts');
  git('commit', '-m', 'branch change');
  writeFileSync(join(workspace, 'src', 'review.ts'), 'export const review = "changed";\n', 'utf8');
  writeFileSync(join(workspace, 'src', 'staged.ts'), 'export const staged = "changed";\n', 'utf8');
  git('add', 'src/staged.ts');
});

test.afterAll(() => rmSync(workspace, { recursive: true, force: true }));

test('reviews all scopes, restores stale state, cancels explicitly, and never mutates Git', async ({
  appPage,
}, testInfo) => {
  const before = repositoryEvidence();

  const codeProHome = appPage.getByRole('heading', { name: '我是 CodeBuddy，一起把事情做好。' });
  const codeProSwitch = appPage.getByRole('button', { name: 'CodePro', exact: true });
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (await codeProHome.isVisible().catch(() => false)) break;
    if (await codeProSwitch.isVisible().catch(() => false)) {
      await codeProSwitch.click().catch(() => {});
    }
    await appPage.waitForTimeout(250);
  }
  await expect(codeProHome).toBeVisible();
  await appPage.evaluate((dir) => window.electron.addRecentDir(dir), workspace);
  await appPage.getByRole('button', { name: '请选择目录' }).click();
  await appPage.getByRole('menuitem').filter({ hasText: 'codepro-review-center-e2e' }).click();
  const input = appPage.getByTestId('chat-input');
  await input.fill('回复本地测试确认');
  await input.press('Enter');
  const workspaceConfirmation = appPage.getByRole('heading', {
    name: '选择这个对话所属的项目',
  });
  await expect(workspaceConfirmation).toBeVisible();
  await appPage.getByRole('button', { name: '使用这个文件夹', exact: true }).click();
  await expect(workspaceConfirmation).not.toBeVisible();
  await expect(appPage.getByText(/CodePro 本地测试响应：已收到请求。/u).last()).toBeVisible({
    timeout: 120_000,
  });
  await expect(appPage.getByRole('button', { name: '发送' })).toBeVisible({ timeout: 120_000 });

  await appPage.getByRole('button', { name: '打开 CodePro 任务面板' }).click();
  const panel = appPage.getByRole('complementary', { name: 'CodePro 任务' });
  await panel.getByRole('button', { name: '版本控制', exact: true }).click();
  await expect(panel.getByRole('heading', { name: '仓库', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '审查更改' }).click();

  const review = panel.getByRole('region', { name: '代码审查' });
  await expect(review.getByRole('button', { name: '工作区' })).toBeVisible();
  await expect(review.getByRole('button', { name: '已暂存' })).toBeVisible();
  await expect(review.getByRole('button', { name: '分支' })).toBeVisible();

  await review.getByRole('button', { name: '预览审查' }).click();
  await expect(review.getByText('模型：openai / codepro-e2e')).toBeVisible();
  await review.getByRole('button', { name: '开始审查' }).click();
  await expect(review.getByText(/Deterministic review finding/u)).toBeVisible({ timeout: 30_000 });
  await expect(review.getByText(/src\/review\.ts:1 \(新版本\)/u)).toBeVisible();

  await review.getByRole('button', { name: '已暂存' }).click();
  await review.getByRole('button', { name: '预览审查' }).click();
  await expect(review.getByText('模型：openai / codepro-e2e')).toBeVisible();

  await review.getByRole('button', { name: '分支' }).click();
  await review.getByLabel('基准分支或引用').fill('comparison');
  await review.getByRole('button', { name: '预览审查' }).click();
  await expect(review.getByText('模型：openai / codepro-e2e')).toBeVisible();

  await review.getByRole('button', { name: '工作区' }).click();
  await review.getByRole('button', { name: '预览审查' }).click();
  await review.getByRole('button', { name: '开始审查' }).click();
  await expect(review.getByText(/Deterministic review finding/u)).toBeVisible({ timeout: 30_000 });
  writeFileSync(join(workspace, 'src', 'review.ts'), 'export const review = "stale";\n', 'utf8');

  await appPage.reload({ waitUntil: 'domcontentloaded' });
  const reloadedPanel = appPage.getByRole('complementary', { name: 'CodePro 任务' });
  await reloadedPanel.getByRole('button', { name: '版本控制', exact: true }).click();
  await reloadedPanel.getByRole('button', { name: '审查更改' }).click();
  const reloadedReview = reloadedPanel.getByRole('region', { name: '代码审查' });
  await expect(reloadedReview.getByText('此审查已过期。')).toBeVisible({ timeout: 30_000 });
  await expect(reloadedReview.locator('pre')).toContainText('1\texport const review = "changed";');

  writeFileSync(join(workspace, 'cancel-review.ts'), 'export const cancel = true;\n', 'utf8');
  const expectedAfterTestWrites = repositoryEvidence();
  await reloadedReview.getByRole('button', { name: '预览审查' }).click();
  await reloadedReview.getByRole('button', { name: '开始审查' }).click();
  await expect(reloadedReview.getByRole('button', { name: '取消审查' })).toBeVisible();
  await reloadedReview.getByRole('button', { name: '取消审查' }).click();
  await expect(reloadedReview.getByText('审查已取消。')).toBeVisible();

  const after = repositoryEvidence();
  expect(after).toEqual(expectedAfterTestWrites);
  expect(after.head).toBe(before.head);
  expect(after.index).toBe(before.index);

  await appPage.screenshot({
    path: testInfo.outputPath('codepro-review-center.png'),
    fullPage: true,
  });
});
