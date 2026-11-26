import { chromium, expect, test } from '@playwright/test';
import { createServer } from 'vite';
import { resolve } from 'node:path';
test('pet preview stays compact and controls remain usable at narrow widths', async () => {
  test.setTimeout(120000);
  const server = await createServer({ configFile: resolve('vite.renderer.config.mts'), server: { host: '127.0.0.1', port: 0, hmr: false } });
  const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : process.platform === 'darwin' ? 'chrome' : undefined });
  try {
    await server.listen();
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/pet-settings.html', { timeout: 90000 });
    const preview = page.locator('.pet-settings-preview');
    await expect(preview).toBeVisible();
    expect((await preview.boundingBox())!.height).toBeLessThan(260);
    const replay = page.getByRole('button', { name: /Replay animation|重播动作/ });
    await replay.click();
    await expect(page.getByRole('heading', { name: /My pets|我的虚拟宠物/ })).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath('pet-settings-compact.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(replay).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await replay.click();
  } finally { await browser.close(); await server.close(); }
});
