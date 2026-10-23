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
    cacheDir: (cacheDirectory = await mkdtemp(resolve(tmpdir(), 'codebuddy-settings-vite-'))),
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
    basename(cacheDirectory).startsWith('codebuddy-settings-vite-')
  )
    await rm(cacheDirectory, { recursive: true, force: true });
});

test('settings no longer exposes storage management or a storage search destination', async () => {
 const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
 try {
  await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/settings-navigation.html');
  await expect(page.getByTestId('settings-navigation')).toBeVisible();
  await expect(page.getByTestId('settings-nav-keyboard')).toBeVisible();
  await expect(page.getByTestId('settings-nav-sharing')).toHaveCount(0);
  await expect(page.getByText('CodeBuddy 服务器', {exact:true})).toHaveCount(0);
  await expect(page.getByTestId('settings-nav-storage')).toHaveCount(0);
  await page.getByTestId('settings-search').fill('存储');
  await expect(page.getByTestId('settings-nav-storage')).toHaveCount(0);
  await expect(page.getByText('存储管理', {exact:true})).toHaveCount(0);
  await page.getByTestId('settings-search').fill('');
  await expect(page.getByTestId('settings-nav-keyboard')).toBeVisible();
  await expect(page.getByTestId('settings-nav-sharing')).toHaveCount(0);
  await expect(page.getByText('CodeBuddy 服务器', {exact:true})).toHaveCount(0);
  await page.screenshot({path:test.info().outputPath('settings.png')});
 } finally { await page.close(); }
});
