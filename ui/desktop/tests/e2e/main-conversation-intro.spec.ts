import { expect, test } from './fixtures';

test.setTimeout(180_000);

test('the main conversation explains how to get started until the first message', async ({ appPage }, testInfo) => {
  await appPage.getByRole('button', { name: '主对话', exact: true }).click();
  const introduction = appPage.getByRole('article').filter({ has: appPage.getByRole('heading', { name: '你好，我是 CodeBuddy，你的项目助手。' }) });
  await expect(introduction).toBeVisible();
  await expect(introduction.getByText('CodeBuddy', { exact: true })).toBeVisible();
  await expect(introduction.locator('img')).toBeVisible();
  const avatar = await introduction.locator('img').boundingBox();
  const viewport = await appPage.locator('[data-conversation-scroll]:visible').boundingBox();
  expect(avatar).toBeTruthy();
  expect(viewport).toBeTruthy();
  expect(avatar!.y - viewport!.y).toBeGreaterThanOrEqual(0);
  expect(avatar!.y - viewport!.y).toBeLessThan(40);
  await expect(introduction.getByText('你可以直接问我：“帮我查一下项目进度。”')).toBeVisible();
  const progressBar = appPage.getByRole('button', { name: /项目进度/ });
  await expect(progressBar).toHaveCount(0);
  const input = appPage.locator('[data-testid="chat-input"]:visible');
  await input.fill('帮我梳理今天的计划');
  await expect(introduction).toBeVisible();
  await appPage.screenshot({ path: testInfo.outputPath('main-conversation.png') });
  await input.press('Enter');
  await expect(appPage.getByText('帮我梳理今天的计划', { exact: true }).first()).toBeVisible();
  await expect(introduction).toBeHidden();
  const replyAvatar = appPage.locator('.main-conversation-turn').last().getByText('CodeBuddy', { exact: true }).locator('..').locator('img');
  await expect(replyAvatar).toBeVisible();
  expect(Math.abs((await replyAvatar.boundingBox())!.x - avatar!.x)).toBeLessThan(2);
  await expect(progressBar).toHaveCount(0);
});
