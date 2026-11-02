import { chromium, expect, test, type Browser } from '@playwright/test';
import { resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
let server: ViteDevServer;
let browser: Browser;
test.beforeAll(async () => {
  server = await createServer({
    configFile: resolve('vite.renderer.config.mts'),
    server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  await server.listen();
  browser = await chromium.launch({
    channel:
      process.platform === 'win32'
        ? 'msedge'
        : process.platform === 'darwin'
          ? 'chrome'
          : undefined,
  });
});
test.afterAll(async () => {
  await browser?.close();
  await server?.close();
});
for (const width of [860, 340, 300]) {
  test('compact question at ' + width + 'px', async ({}, info) => {
    const page = await browser.newPage({ viewport: { width, height: 620 } });
    try {
      await page.goto(
        server.resolvedUrls!.local[0] +
          'tests/browser-fixtures/questions.html' +
          (width < 400 ? '?dark' : '')
      );
      const card = page.getByRole('region', { name: '问题' }),
        field = card.getByRole('textbox', { name: /主窗口/ }),
        send = card.getByRole('button', { name: '发送' });
      await expect(field).toBeVisible();
      const box = (await card.boundingBox())!,
        entry = (await field.boundingBox())!,
        action = (await send.boundingBox())!;
      const title = (await card.getByRole('button', { name: '收起问题' }).boundingBox())!;
      await expect(field).toHaveAttribute('placeholder', '输入你的回答…');
      await expect(field).toHaveCSS('font-size', '16px');
      expect(entry.height).toBeGreaterThanOrEqual(64);
      expect(box.height - title.height - entry.height).toBeLessThan(width >= 340 ? 20 : 55);
      expect(box.width).toBeLessThanOrEqual(576);
      if (width >= 340) {
        expect(entry.width).toBeGreaterThan(130);
        expect(action.x).toBeGreaterThan(entry.x + entry.width);
      } else {
        expect(action.y).toBeGreaterThanOrEqual(entry.y + entry.height);
      }
      await card.screenshot({ path: info.outputPath('question.png') });
      await send.click();
      await expect(card.getByRole('alert')).toBeVisible();
      await field.click();
      await page.keyboard.insertText('CodeBuddy');
      await field.press('Enter');
      await page.keyboard.insertText('测试窗口');
      await card.getByRole('button', { name: '收起问题' }).click();
      await expect(field).toBeHidden();
      await card.getByRole('button', { name: '展开待回答的问题' }).click();
      await expect(field).toHaveValue('CodeBuddy\n测试窗口');
      await field.fill(Array(12).fill('长回答换行测试').join('\n'));
      const expanded = (await field.boundingBox())!;
      expect(expanded.height).toBeGreaterThan(entry.height);
      expect(expanded.height).toBeLessThanOrEqual(160);
      await field.fill('CodeBuddy\n测试窗口');
      await send.click();
      await expect(page.locator('output')).toContainText('CodeBuddy');
    } finally {
      await page.close();
    }
  });
}
test('narrow multi-question form keeps answers on back and supports skip', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 530 } });
  try {
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/questions.html?multi');
    const card = page.getByRole('region', { name: '问题' });
    await card.getByRole('textbox').fill('测试');
    await card.getByRole('button', { name: '下一条' }).click();
    await expect(card.getByText('2 / 2')).toBeVisible();
    expect(await card.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1);
    await card.getByRole('button', { name: '返回' }).click();
    await expect(card.getByRole('textbox')).toHaveValue('测试');
    await card.getByRole('button', { name: '跳过' }).click();
    await expect(page.locator('output')).toContainText('cancel');
  } finally {
    await page.close();
  }
});
