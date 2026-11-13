import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures';

test.setTimeout(480_000);

// The existing local provider deliberately reuses chatcmpl-codepro-e2e for
// every response. Do not make it generate unique IDs to satisfy this test.
test('Message identity keeps separate answers when a provider reuses its response ID, including reload', async ({
  appPage,
  isolatedProfileRoot,
}, testInfo) => {
  const workspace = join(isolatedProfileRoot, 'identity-workspace');
  mkdirSync(workspace, { recursive: true });
  await expect(appPage.getByRole('heading', { name: '我是 CodeBuddy，一起把事情做好。' })).toBeVisible();
  await appPage.evaluate((dir) => window.electron.addRecentDir(dir), workspace);
  await appPage.reload();
  await appPage.keyboard.press('Escape');
  await appPage.getByRole('button', { name: '选择工作区', exact: true }).click();
  await appPage.getByRole('menuitem').filter({ hasText: 'identity-workspace' }).click();
  await expect(appPage.getByRole('button', { name: workspace, exact: true })).toBeVisible();
  await expect(appPage.getByRole('button', { name: /codepro-e2e/i }).first()).toBeVisible();

  const input = appPage.getByTestId('chat-input');
  const answers = appPage
    .getByTestId('message-container')
    .getByText('CodePro 本地测试响应：已收到请求。', { exact: true });
  await input.fill('回复本地测试确认');
  await input.press('Enter');
  await expect(answers).toHaveCount(1, { timeout: 120_000 });
  await expect(appPage.getByRole('button', { name: '发送', exact: true })).toBeVisible();

  await input.fill('再回复本地测试确认');
  await input.press('Enter');
  await expect(answers).toHaveCount(2, { timeout: 120_000 });
  await expect(appPage.getByRole('button', { name: '发送', exact: true })).toBeVisible();
  await appPage.screenshot({ path: testInfo.outputPath('two-live-answers.png'), fullPage: true });

  await appPage.reload();
  await expect(answers).toHaveCount(2, { timeout: 120_000 });
  const history = appPage.locator('[data-turn-process-summary]').last();
  await history.locator('.codepro-group-heading').first().click();
  const processGroup = history.locator('[data-process-group]').first();
  await processGroup.locator('.codepro-group-heading').first().click();
  const thought = processGroup.locator('.codepro-thinking-record button').first();
  await expect(thought).toHaveAttribute('aria-expanded', 'false');
  await expect(thought).toContainText('核对请求。');
  await thought.focus();
  await appPage.keyboard.press('Space');
  await expect(processGroup.getByText('检查回复是否保留。', { exact: true })).toBeVisible();
  await appPage.keyboard.press('Space');
  await expect(processGroup.getByText('检查回复是否保留。', { exact: true })).toBeHidden();
  await expect(answers).toHaveCount(2);
  await appPage.screenshot({
    path: testInfo.outputPath('two-replayed-answers.png'),
    fullPage: true,
  });
});
