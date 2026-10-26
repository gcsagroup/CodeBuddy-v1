import { chromium, expect, test, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve, dirname, basename } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

let server: ViteDevServer;
let browser: Browser;
let cacheDirectory: string;
test.beforeAll(async () => {
  server = await createServer({
    configFile: resolve('vite.renderer.config.mts'),
    cacheDir: (cacheDirectory = await mkdtemp(resolve(tmpdir(), 'codebuddy-generation-vite-'))),
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
    basename(cacheDirectory).startsWith('codebuddy-generation-vite-')
  )
    await rm(cacheDirectory, { recursive: true, force: true });
});
for (const kind of ['image', 'video']) {
  test(`${kind}: local animation, real progress and final media in a real browser`, async () => {
    const page = await browser.newPage({ viewport: { width: 420, height: 640 }, locale: 'zh-CN' });
    try {
      await page.goto(
        `${server.resolvedUrls!.local[0]}tests/browser-fixtures/generation-wait.html?${kind}`
      );
      await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '61');
      await expect(page.locator('img, video')).toHaveCount(0);
      await expect(page.getByTestId('generation-wait')).toBeVisible();
      await page.screenshot({ path: test.info().outputPath('generation-wait.png') });
      await page.getByRole('button', { name: 'queued', exact: true }).click();
      await expect(page.getByRole('progressbar')).toHaveCount(0);
      await expect(page.getByTestId('generation-wait')).toContainText('请稍候');
      for (const state of ['failed', 'cancelled']) {
        await page.getByRole('button', { name: state, exact: true }).click();
        await expect(page.getByTestId('generation-wait')).toHaveCount(0);
      }
      await page.getByRole('button', { name: 'completed', exact: true }).click();
      await expect(page.getByTestId('generation-wait')).toHaveCount(0);
      if (kind === 'image') {
        await expect(page.getByRole('img')).toBeVisible();
        expect(
          await page.getByRole('img').evaluate((el: HTMLImageElement) => el.naturalWidth)
        ).toBe(100);
      } else {
        await expect(page.locator('video')).toHaveAttribute('controls');
        await page.locator('video').evaluate(async (video: HTMLVideoElement) => {
          video.muted = true;
          await video.play();
        });
        await expect
          .poll(() =>
            page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)
          )
          .toBeGreaterThan(0);
      }
      await page.setViewportSize({ width: 280, height: 640 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(
        `${server.resolvedUrls!.local[0]}tests/browser-fixtures/generation-wait.html?${kind}&dark`
      );
      await expect(page.getByTestId('generation-wait')).toBeVisible();
      await expect(page.locator('.generation-wait-sweep')).toHaveCSS('animation-name', 'none');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      );
      await page.screenshot({ path: test.info().outputPath('generation-wait-dark-narrow.png') });
    } finally {
      await page.close();
    }
  });
}
