import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures';

test.describe.configure({ timeout: 180000 });

test('Long turn status shows the current model call, small cache hit and turn total', async ({
  appPage: page, isolatedProfileRoot,
}, info) => {
  const cwd = join(isolatedProfileRoot, 'progress-workspace');
  mkdirSync(cwd);
  await page.evaluate(dir => window.electron.addRecentDir(dir), cwd);
  await page.reload();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^(选择工作区|请选择目录)$/ }).click();
  await page.getByRole('menuitem').filter({ hasText: 'progress-workspace' }).click();
  await expect(page.getByRole('button', { name: /codepro-e2e/i }).first()).toBeVisible();
  const input = page.getByTestId('chat-input');
  await input.fill('LONG_TURN_USAGE_FIXTURE 回复本地测试确认');
  await input.press('Enter');
  const waiting = page.getByTestId('loading-indicator').filter({hasText: /第 1 次模型调用.*等待模型服务返回/});
  await expect(waiting).toBeVisible();
  await waiting.screenshot({ path: info.outputPath('waiting.png') });
  await expect(page.getByTestId('composer-stats')).toContainText('0.45%');
  await expect(page.getByText('本轮累计', { exact: true }).first()).toBeVisible();
  await page.getByTestId('context-window-indicator').hover();
  await expect(page.getByText(/自动压缩触发线.*tokens/)).toBeVisible();
  await page.screenshot({ path: info.outputPath('completed.png') });
});
