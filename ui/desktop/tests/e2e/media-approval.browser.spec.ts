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
    cacheDir: (cacheDirectory = await mkdtemp(resolve(tmpdir(), 'codebuddy-approval-vite-'))),
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
    basename(cacheDirectory).startsWith('codebuddy-approval-vite-')
  )
    await rm(cacheDirectory, { recursive: true, force: true });
});
for (const tool of [
  'generate_image',
  'generate_video',
  'browser_control',
  'create_desktop_pet',
  'project_memory',
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
]) {
  test(`${tool} exposes the same choices and returns the session decision`, async () => {
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 800, height: 400 } });
    try {
      await page.goto(
        `${server.resolvedUrls!.local[0]}tests/browser-fixtures/media-approval.html?tool=${tool}`
      );
      await expect(page.getByRole('button', { name: '拒绝', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '仅此次允许', exact: true })).toBeVisible();
      const allow = page.getByRole('button', { name: '本会话允许此工具', exact: true });
      await expect(allow).toBeVisible();
      await page.screenshot({ path: test.info().outputPath('media-approval.png') });
      await page.setViewportSize({ width: 360, height: 400 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      );
      await expect(allow).toBeVisible();
      await allow.click();
      await expect(page.locator('#reply')).toContainText('"optionId":"allow_always"');
      await expect(page.getByRole('button')).toHaveCount(0);
    } finally {
      await page.close();
    }
  });
}
