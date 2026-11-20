import { chromium, expect, test } from '@playwright/test';
import { createServer } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('long history restores jumps, searches hidden receipts and releases search pages', async ({}, info) => {
  test.setTimeout(120000);
  const cache = await mkdtemp(resolve(tmpdir(), 'cb-history-window-'));
  const server = await createServer({
    configFile: resolve('vite.renderer.config.mts'), cacheDir: cache,
    optimizeDeps: { entries: ['tests/browser-fixtures/work-history-window.html'], holdUntilCrawlEnd: false },
    server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
  try {
    await server.listen();
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    const errors: string[] = [];
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/work-history-window.html');
    const viewport = page.locator('[data-radix-scroll-area-viewport]');
    const receipts = page.locator('[data-receipt]');
    await expect(page.locator('[data-work-history-placeholder]').first()).toBeAttached();
    await expect.poll(() => receipts.count()).toBeLessThan(100);
    const before = await receipts.count();
    for (const fraction of [1, 0, 0.7, 0.3]) {
      await viewport.evaluate((element, fraction) => { element.scrollTop = fraction * (element.scrollHeight - element.clientHeight); }, fraction);
      await expect.poll(() => viewport.evaluate(element => {
        const box = element.getBoundingClientRect();
        return [...element.querySelectorAll('[data-receipt]')].some(row => {
          const rect = row.getBoundingClientRect();
          return rect.bottom > box.top && rect.top < box.bottom;
        });
      })).toBe(true);
    }
    await page.keyboard.press('Control+f');
    await page.getByRole('textbox').fill('Receipt 144:');
    await expect(page.locator('[data-receipt="144"]')).toBeAttached();
    await expect.poll(() => page.evaluate(() => CSS.highlights.get('conversation-find')?.size ?? 0)).toBe(1);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect.poll(() => receipts.count()).toBeLessThan(100);
    await page.getByRole('button', { name: 'Append receipt' }).click();
    await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(page.locator('[data-receipt="288"]')).toBeVisible();
    await page.getByText('Details 288', { exact: true }).click();
    await expect(page.locator('[data-receipt="288"] details')).toHaveJSProperty('open', true);
    await expect(page.locator('[data-receipt="288"] details')).toContainText('Expanded output 288');
    await page.screenshot({ path: info.outputPath('long-history.png') });
    await info.attach('mount-counts', { body: JSON.stringify({ total: 288, before, afterSearch: await receipts.count() }), contentType: 'application/json' });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await server.close();
    await rm(cache, { recursive: true, force: true });
  }
});
