import { chromium, expect, test, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve, dirname, basename } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
let server: ViteDevServer;
let browser: Browser;
let cache: string;
test.beforeAll(async () => {
  cache = await mkdtemp(resolve(tmpdir(), 'codebuddy-shell-vite-'));
  server = await createServer({
    configFile: resolve('vite.renderer.config.mts'),
    cacheDir: cache,
    optimizeDeps: { entries: ['tests/browser-fixtures/window-shell.html'] },
    server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  await server.listen();
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
});
test.afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (
    cache &&
    dirname(resolve(cache)) === resolve(tmpdir()) &&
    basename(cache).startsWith('codebuddy-shell-vite-')
  ) {
    await rm(cache, { recursive: true, force: true });
  }
});
test('menu navigation preserves typing and the composer stays inside resized content', async () => {
  const page = await browser.newPage();
  await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/window-shell.html');
  for (const size of [
    { width: 1280, height: 720 },
    { width: 480, height: 400 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(size);
    const input = page.getByLabel('Message', { exact: true });
    await input.fill('中文输入与菜单焦点');
    await page.getByRole('menuitem', { name: '编辑' }).click();
    await expect(input).toBeFocused();
    await expect(page.locator('output')).toHaveText('1');
    const inputBox = (await input.boundingBox())!;
    expect(inputBox.y + inputBox.height).toBeLessThanOrEqual(size.height);
    const menuBox = (await page.getByRole('menuitem', { name: '帮助' }).boundingBox())!;
    expect(menuBox.x + menuBox.width).toBeLessThan(size.width - 140);
    await page.keyboard.press('F10');
    await expect(page.getByRole('menuitem', { name: '文件' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(input).toBeFocused();
  }
  await page.close();
});
