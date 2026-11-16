import { chromium, expect, test, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve, dirname, basename } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

let browser: Browser, server: ViteDevServer, cache: string;
test.beforeAll(async () => {
  cache = await mkdtemp(resolve(tmpdir(), 'codebuddy-loading-'));
  server = await createServer({ configFile: resolve('vite.renderer.config.mts'), cacheDir: cache,
    optimizeDeps: { entries: ['tests/browser-fixtures/conversation-loading.html'] },
    server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen();
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
});
test.afterAll(async () => {
  await browser?.close(); await server?.close();
  if (cache && dirname(resolve(cache)) === resolve(tmpdir()) && basename(cache).startsWith('codebuddy-loading-'))
    await rm(cache, { recursive: true, force: true });
});
for (const dark of [false, true]) test(`loading stays readable and centered (${dark ? 'dark' : 'light'})`, async () => {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  try {
    await page.goto(server.resolvedUrls!.local[0] + `tests/browser-fixtures/conversation-loading.html${dark ? '?dark' : ''}`);
    const status = page.getByRole('status');
    for (const width of [360, 1100]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(status).toHaveText('正在加载对话…');
      await expect(status).toBeVisible();
      const bounds = (await status.boundingBox())!;
      const area = (await page.getByTestId('conversation-area').boundingBox())!;
      expect(Math.abs(bounds.x + bounds.width / 2 - (area.x + area.width / 2))).toBeLessThan(2);
      expect(Math.abs(bounds.y + bounds.height / 2 - (area.y + area.height / 2))).toBeLessThan(2);
      await expect(status).toHaveCSS('font-size', '18px');
      await expect(status).toHaveCSS('opacity', '1');
      const brand = status.locator('.conversation-loading-brand');
      await expect(brand.locator('img')).toBeVisible();
      expect((await brand.boundingBox())!.width).toBeGreaterThanOrEqual(92);
      expect(await brand.evaluate(element => getComputedStyle(element, '::before').animationName)).toBe('none');
    }
    await page.screenshot({ path: test.info().outputPath('loading.png') });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const brand = status.locator('.conversation-loading-brand');
    expect(await brand.evaluate(element => getComputedStyle(element, '::before').animationName)).toBe('conversation-loading-orbit');
    const firstTransform = await brand.evaluate(element => getComputedStyle(element, '::before').transform);
    await expect.poll(() => brand.evaluate(element => getComputedStyle(element, '::before').transform))
      .not.toBe(firstTransform);
    await page.getByRole('button', { name: '切换加载状态' }).click();
    await expect(status).toHaveCount(0);
    await expect(page.getByText('历史内容已显示')).toBeVisible();
    await page.getByRole('button', { name: '切换加载状态' }).click();
    await expect(status).toBeVisible();
  } finally { await page.close(); }
});
