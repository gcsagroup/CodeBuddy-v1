import { mkdirSync } from 'node:fs';
import { expect, test as base } from './fixtures';

const test = base.extend({
  isolatedProfileRoot: async ({}, use, testInfo) => {
    const root = testInfo.outputPath('profile');
    mkdirSync(root, { recursive: true });
    await use(root);
  },
});

test.setTimeout(180_000);

test('New task retains its prompt across another conversation and clears only after Send', async ({
  appPage,
}, testInfo) => {
  const input = () =>
    appPage.locator('main[aria-labelledby="codepro-title"] [data-testid="chat-input"]');
  await input().fill('草稿验收：原会话');
  await input().press('Enter');
  await expect.poll(() => new URL(appPage.url()).hash).toContain('resumeSessionId');
  const firstRoute = new URL(appPage.url()).hash;
  await expect(appPage.locator('[data-session-id]:visible')).toBeVisible();
  await expect(appPage.locator('aside .group\\/session-row').first()).toBeVisible();
  await appPage.getByRole('button', { name: '新任务', exact: true }).click();
  const draft = '  帮我整理中文提示词 🙂\n第二行，尚未发送  ';
  await input().fill(draft);
  for (let i = 0; i < 2; i++) {
    await appPage.locator('aside .group\\/session-row').first().click();
    await expect.poll(() => new URL(appPage.url()).hash).toBe(firstRoute);
    await expect(appPage.locator('[data-session-id]:visible')).toBeVisible();
    await appPage.getByRole('button', { name: '新任务', exact: true }).click();
    await expect(input()).toHaveValue(draft);
  }
  await appPage.getByRole('button', { name: '工具箱', exact: true }).click();
  await appPage.getByRole('button', { name: '新任务', exact: true }).click();
  await expect(input()).toHaveValue(draft);
  await appPage.screenshot({ path: testInfo.outputPath('draft-restored.png') });
  await input().press('Enter');
  await expect.poll(() => new URL(appPage.url()).hash).toContain('resumeSessionId');
  await expect(appPage.locator('[data-session-id]:visible')).toBeVisible();
  expect(new URL(appPage.url()).hash).not.toBe(firstRoute);
  await appPage.getByRole('button', { name: '新任务', exact: true }).click();
  await expect(input()).toHaveValue('');
  await appPage.screenshot({ path: testInfo.outputPath('draft-cleared-after-send.png') });
});
