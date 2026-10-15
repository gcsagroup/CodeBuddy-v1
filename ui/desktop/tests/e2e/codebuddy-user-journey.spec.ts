import type { Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './fixtures';

test.setTimeout(480_000);

async function expectCodeProHome(appPage: Page) {
  await expect(appPage.getByRole('heading', { name: '欢迎使用 CodePro' })).toBeVisible();
  await expect(appPage.getByText('自动拆分任务')).toBeVisible();
  await expect(appPage.getByText('多模型协作')).toBeVisible();
  await expect(appPage.getByText('原位编辑并保留完整活动记录')).toBeVisible();
  await expect(appPage.getByTestId('chat-input')).toBeVisible();
}

async function continueWithSelectedProject(appPage: Page) {
  await expect(appPage.getByRole('heading', { name: '选择这个对话所属的项目' })).toBeVisible();
  await appPage.getByRole('button', { name: '继续这个项目', exact: true }).click();
  await expect(appPage.getByRole('heading', { name: '选择这个对话所属的项目' })).not.toBeVisible();
}

test('opens the unified CodePro home', async ({ appPage }, testInfo) => {
  await expectCodeProHome(appPage);
  await appPage.screenshot({
    path: testInfo.outputPath('codepro-home.png'),
    fullPage: true,
  });
});

test('opens current workspace destinations', async ({ appPage }) => {
  await expectCodeProHome(appPage);

  for (const label of ['常用任务', '自动任务', '工具箱', '历史记录']) {
    await appPage.getByRole('button', { name: label, exact: true }).click();
    await expect(appPage.locator('#root')).toBeVisible();
    await expect(appPage.getByRole('heading', { name: label, exact: true })).toBeVisible();
  }

  await appPage.getByRole('button', { name: '新任务', exact: true }).click();
  await expectCodeProHome(appPage);
});

test('keeps common task controls usable at the minimum window width', async ({ appPage }) => {
  await expectCodeProHome(appPage);
  await appPage.setViewportSize({ width: 480, height: 400 });
  const expandNavigation = appPage.getByRole('button', { name: '展开导航', exact: true });
  if (await expandNavigation.isVisible()) {
    await expandNavigation.click();
  }
  await appPage.getByRole('button', { name: '常用任务', exact: true }).click();

  const heading = appPage.getByRole('heading', { name: '常用任务' });
  const createButton = appPage.getByRole('button', { name: '创建常用任务', exact: true });
  const importButton = appPage.getByRole('button', { name: '导入配方', exact: true });
  await expect(heading).toBeVisible();
  await expect(createButton).toBeVisible();
  await expect(importButton).toBeVisible();

  const headingBox = await heading.boundingBox();
  const createButtonBox = await createButton.boundingBox();
  const importButtonBox = await importButton.boundingBox();
  expect(headingBox?.height).toBeLessThan(80);
  expect(createButtonBox?.x).toBeGreaterThanOrEqual(0);
  expect((createButtonBox?.x ?? 0) + (createButtonBox?.width ?? 0)).toBeLessThanOrEqual(480);
  expect(importButtonBox?.x).toBeGreaterThanOrEqual(0);
  expect((importButtonBox?.x ?? 0) + (importButtonBox?.width ?? 0)).toBeLessThanOrEqual(480);
});

test('changes the theme from Settings', async ({ appPage }) => {
  await appPage.getByRole('button', { name: '设置', exact: true }).click();
  await expect(appPage.getByRole('heading', { name: '设置' })).toBeVisible();
  await appPage.getByTestId('settings-nav-app').click();

  await appPage.getByRole('button', { name: '深色', exact: true }).click();
  await expect(appPage.locator('html')).toHaveClass(/dark/);
  await appPage.getByRole('button', { name: '浅色', exact: true }).click();
  await expect(appPage.locator('html')).not.toHaveClass(/dark/);
});

test('opens the CodePro agent model configuration', async ({ appPage }) => {
  await expectCodeProHome(appPage);
  await appPage.getByRole('button', { name: '选择或更改模型' }).click();
  await appPage.getByRole('menuitem', { name: '配置 Agent 模型' }).click();
  const dialog = appPage.getByRole('dialog');
  await expect(dialog).toContainText('Agent 模型配置');
  await dialog.getByRole('checkbox', { name: '启用高级模型路由' }).check();

  for (const role of ['分析 Agent', '编码 Agent', '测试 Agent', '审查 Agent']) {
    await expect(appPage.getByLabel(`${role}提供商`)).toBeVisible();
    await expect(appPage.getByLabel(`${role}模型`)).toBeVisible();
  }

  await appPage.getByRole('button', { name: '取消', exact: true }).click();
  await expect(appPage.getByRole('dialog')).not.toBeVisible();
});

test('starts a new conversation from a secondary view', async ({ appPage }) => {
  await appPage.getByRole('button', { name: '设置', exact: true }).click();
  await expect(appPage.getByRole('heading', { name: '设置' })).toBeVisible();
  await appPage.getByRole('button', { name: '新任务', exact: true }).click();
  await expectCodeProHome(appPage);
});

test('creates an exact workspace and continues without a second confirmation', async ({
  appPage,
  registerArtifactCleanup,
}) => {
  let ordinal = 1;
  let workspace = 'C:\\codepro-project';
  while (existsSync(workspace)) {
    ordinal += 1;
    workspace = `C:\\codepro-project-${ordinal}`;
  }
  const prompt = 'Build the isolated CodePro E2E project in the selected container.';
  registerArtifactCleanup(workspace);
  expect(existsSync(workspace)).toBe(false);
  await appPage.evaluate((dir) => window.electron.addRecentDir(dir), 'C:\\');
  const unboundDirectory = appPage.getByRole('button', { name: '请选择目录' });
  await unboundDirectory.click();
  await appPage.getByRole('menuitem').filter({ hasText: 'C:' }).click();
  await expect(appPage.getByRole('button', { name: 'C:' })).toBeVisible();
  const input = appPage.getByTestId('chat-input');
  await input.fill(prompt);
  await input.press('Enter');

  await expect(appPage.getByRole('heading', { name: '选择这个对话所属的项目' })).not.toBeVisible();
  await expect.poll(() => existsSync(workspace), { timeout: 60_000 }).toBe(true);
});

test('executes the confirmed change plan through coder and tester', async ({
  appPage,
  isolatedProfileRoot,
}, testInfo) => {
  const workspace = join(isolatedProfileRoot, 'change-workspace');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(join(workspace, 'tests'), { recursive: true });
  writeFileSync(
    join(workspace, 'package.json'),
    JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }, null, 2),
    'utf8'
  );
  writeFileSync(
    join(workspace, 'src', 'controller.js'),
    "export function greeting() { return 'old'; }\n",
    'utf8'
  );
  writeFileSync(
    join(workspace, 'src', 'route.js'),
    "import { greeting } from './controller.js';\nexport function handle() { return greeting(); }\n",
    'utf8'
  );

  await appPage.evaluate((dir) => window.electron.addRecentDir(dir), workspace);
  const unboundDirectory = appPage.getByRole('button', { name: '请选择目录' });
  await unboundDirectory.click();
  await appPage.getByRole('menuitem').filter({ hasText: 'change-workspace' }).click();
  await expect(appPage.getByRole('button', { name: 'change-workspace' })).toBeVisible();
  const input = appPage.getByTestId('chat-input');
  await input.fill(`请在 "${workspace}" Implement the greeting route and add tests.`);
  await input.press('Enter');
  await continueWithSelectedProject(appPage);

  await expect
    .poll(() => readFileSync(join(workspace, 'src', 'controller.js'), 'utf8'), {
      timeout: 120_000,
    })
    .toContain("return 'hello';");
  await expect
    .poll(() => readFileSync(join(workspace, 'src', 'route.js'), 'utf8'), {
      timeout: 120_000,
    })
    .toContain('return { status: 200, body: greeting() };');
  await expect
    .poll(() => existsSync(join(workspace, 'tests', 'route.test.mjs')), { timeout: 120_000 })
    .toBe(true);
  const terminal = appPage.getByRole('status').filter({ hasText: '测试通过' });
  await expect(terminal).toBeVisible({ timeout: 120_000 });
  await expect(terminal).toContainText('已完成');
  await appPage.screenshot({
    path: testInfo.outputPath('codepro-change-complete.png'),
    fullPage: true,
  });
});

test('Permission approval persists, takes effect, and does not prompt twice', async ({
  appPage,
  isolatedProfileRoot,
}) => {
  const workspace = join(isolatedProfileRoot, 'permission-workspace');
  mkdirSync(join(workspace, 'tests'), { recursive: true });
  writeFileSync(
    join(workspace, 'package.json'),
    JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }, null, 2),
    'utf8'
  );
  writeFileSync(
    join(workspace, 'tests', 'permission.test.mjs'),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { readFileSync } from 'node:fs';",
      "test('both approved actions ran', () => {",
      "  assert.equal(readFileSync('permission-first.txt', 'utf8').trim(), 'first allowed');",
      "  assert.equal(readFileSync('permission-second.txt', 'utf8').trim(), 'second allowed without another prompt');",
      '});',
      '',
    ].join('\n'),
    'utf8'
  );

  await appPage.evaluate((dir) => window.electron.addRecentDir(dir), workspace);
  await appPage.getByRole('button', { name: '请选择目录' }).click();
  await appPage.getByRole('menuitem').filter({ hasText: 'permission-workspace' }).click();
  const input = appPage.getByTestId('chat-input');
  await input.fill('执行两个需要用户授权的本地写入，授权一次后继续并验证权限已经生效');
  await input.press('Enter');
  await continueWithSelectedProject(appPage);

  const approvalActions = appPage.getByTestId('tool-approval-actions');
  await expect(approvalActions).toHaveCount(1, { timeout: 120_000 });
  if (process.env.CODEPRO_E2E_EXTERNAL_PERMISSION === '1') {
    await expect(approvalActions).toHaveCount(0, { timeout: 120_000 });
  } else {
    await appPage.getByRole('button', { name: '本任务允许' }).click();
  }

  await expect.poll(() => existsSync(join(workspace, 'permission-first.txt'))).toBe(true);
  await expect.poll(() => existsSync(join(workspace, 'permission-second.txt'))).toBe(true);
  await expect(appPage.getByRole('heading', { name: '总结' })).toBeVisible({
    timeout: 120_000,
  });
  await expect(appPage.getByTestId('tool-approval-actions')).toHaveCount(0);
  await expect(appPage.getByText(/测试通过/).last()).toBeVisible();
});
