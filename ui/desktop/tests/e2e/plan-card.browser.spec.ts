import { chromium, expect, test, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve, dirname, basename } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

let server: ViteDevServer;
let browser: Browser;
let cacheDirectory: string;
test.beforeAll(async () => {
  cacheDirectory = await mkdtemp(resolve(tmpdir(), 'codebuddy-plan-vite-'));
  server = await createServer({
    configFile: resolve('vite.renderer.config.mts'),
    cacheDir: cacheDirectory,
    server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  await server.listen();
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
});
test.afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (
    cacheDirectory &&
    dirname(resolve(cacheDirectory)) === resolve(tmpdir()) &&
    basename(cacheDirectory).startsWith('codebuddy-plan-vite-')
  ) {
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});

test('task card keeps header above scrollable rows and folds without hiding the composer', async () => {
  const page = await browser.newPage();
  try {
    for (const width of [900, 360]) {
      await page.setViewportSize({ width, height: 700 });
      for (const theme of ['light', 'dark']) {
        await page.goto(server.resolvedUrls!.local[0] + `tests/browser-fixtures/plan-card.html?theme=${theme}`);
        const card = page.getByTestId('work-plan');
        const header = card.locator('summary');
        const body = card.locator('.codepro-operation-details');
        await expect(card).not.toHaveAttribute('open', '');
        await header.click();
        await expect(card).toHaveAttribute('open', '');
        await expect(header).toContainText('2 已完成 · 1 进行中 · 5 待处理');
        const headerBox = await header.boundingBox();
        if (width === 900) expect(headerBox!.width).toBeGreaterThan(800);
        const bodyBox = await body.boundingBox();
        expect(bodyBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height);
        expect(await body.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: test.info().outputPath(`plan-${width}-${theme}.png`) });
        await header.click();
        await expect(card).not.toHaveAttribute('open', '');
        await page.getByRole('textbox', { name: '发送消息' }).fill('继续');
        await header.focus();
        await page.keyboard.press('Enter');
        await expect(card).toHaveAttribute('open', '');
        await expect(page.getByRole('textbox', { name: '发送消息' })).toHaveValue('继续');
      }
    }
  } finally { await page.close(); }
});
