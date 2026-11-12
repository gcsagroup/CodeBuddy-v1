import { chromium, expect, test, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve, dirname, basename } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

let server: ViteDevServer;
let browser: Browser;
let cacheDirectory: string;
test.beforeAll(async () => {
  cacheDirectory = await mkdtemp(resolve(tmpdir(), 'codebuddy-compaction-vite-'));
  server = await createServer({
    configFile: resolve('vite.renderer.config.mts'),
    cacheDir: cacheDirectory,
    optimizeDeps: { entries: ['tests/browser-fixtures/compaction-settings.html'] },
    resolve: {
      alias: [
        {
          find: /^(?:.*\/)?acpConnection(?:\.ts)?$/,
          replacement: resolve('tests/browser-fixtures/compaction-settings-api.ts'),
        },
      ],
    },
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
    basename(cacheDirectory).startsWith('codebuddy-compaction-vite-')
  )
    await rm(cacheDirectory, { recursive: true, force: true });
});

test('compaction menu and optional model keep the existing settings layout on desktop, narrow and dark views', async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  try {
    const url = server.resolvedUrls!.local[0] + 'tests/browser-fixtures/compaction-settings.html';
    await page.goto(url);
    await page.getByRole('button', { name: '上下文压缩', exact: true }).click();
    const select = page.getByLabel('自选兜底模型（可选）');
    await expect(select).toBeEnabled();
    await select.selectOption(JSON.stringify(['fixture', 'qwen3.8-flash-next-uncensored']));
    await page.getByRole('button', { name: '保存压缩设置' }).click();
    await expect(page.getByText('已保存，下次压缩时生效。')).toBeVisible();
    const lightBackground = await page
      .locator('main')
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.screenshot({
      path: test.info().outputPath('compaction-desktop.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await page.screenshot({
      path: test.info().outputPath('compaction-narrow.png'),
      fullPage: true,
    });
    await select.selectOption('');
    await page.getByRole('button', { name: '保存压缩设置' }).click();
    await expect(select).toHaveValue('');
    await page.goto(url + '?dark');
    await page.getByRole('button', { name: '上下文压缩', exact: true }).click();
    await expect(select).toHaveValue('');
    expect(
      await page.locator('main').evaluate((element) => getComputedStyle(element).backgroundColor)
    ).not.toBe(lightBackground);
    await page.screenshot({ path: test.info().outputPath('compaction-dark.png'), fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});
