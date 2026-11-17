import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures';

test.describe.configure({ timeout: 300_000 });

for (const accept of [false, true]) {
  test(`Website handoff: ${accept ? 'accept and inspect' : 'decline and deliver'}`, async ({
    appPage: page, isolatedProfileRoot,
  }, info) => {
    const cwd = join(isolatedProfileRoot, 'website-handoff');
    mkdirSync(cwd);
    await page.evaluate(dir => window.electron.addRecentDir(dir), cwd);
    await page.reload();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^(选择工作区|请选择目录)$/ }).click();
    await page.getByRole('menuitem').filter({ hasText: 'website-handoff' }).click();
    await expect(page.getByRole('button', { name: /codepro-e2e/i }).first()).toBeVisible();
    const permission = page.getByRole('button', { name: '仅此次允许', exact: true });
    await page.addLocatorHandler(permission, () => permission.click());
    const input = page.getByTestId('chat-input');
    await input.fill('WEBSITE_HANDOFF_E2E 帮我做一个作品网站。');
    await input.press('Enter');
    const question = page.getByRole('region', { name: /问题|回复或确认/ });
    await expect(question.getByText('网站已准备好，要在浏览器里测试一下吗？').first()).toBeVisible({ timeout: 90_000 });
    expect(readFileSync(join(cwd, 'index.html'), 'utf8')).toContain('查看作品');
    const tab = page.getByRole('tab', { name: '验收样站' });
    await expect(tab).toHaveCount(0);
    await question.screenshot({ path: info.outputPath('website-choice.png') });
    await question.getByRole('radio', { name: accept ? '开始浏览器验收' : '只给我网站和启动方法' }).click();
    await question.getByRole('button', { name: '发送' }).click();
    if (accept) {
      await expect(tab).toHaveCount(1);
      await expect(page.getByText('已在浏览器读到“查看作品”按钮。', { exact: true }).first()).toBeVisible();
    } else {
      await expect(page.getByRole('link', { name: '网站入口' }).first()).toBeVisible();
      await expect(page.getByText(/双击 index.html 即可启动/).first()).toBeVisible();
      await expect(tab).toHaveCount(0);
    }
  });
}
