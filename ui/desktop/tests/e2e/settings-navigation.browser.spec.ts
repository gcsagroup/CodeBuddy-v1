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
    optimizeDeps: { entries: ['tests/browser-fixtures/settings-navigation.html'] },
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
    await page.goto(
      server.resolvedUrls!.local[0] + 'tests/browser-fixtures/settings-navigation.html'
    );
    await expect(page.getByTestId('settings-navigation')).toBeVisible();
    await expect(page.getByTestId('settings-nav-keyboard')).toBeVisible();
    await expect(page.getByTestId('settings-nav-sharing')).toHaveCount(0);
    await expect(page.getByText('CodeBuddy 服务器', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('settings-nav-storage')).toHaveCount(0);
    await page.getByTestId('settings-search').fill('存储');
    await expect(page.getByTestId('settings-nav-storage')).toHaveCount(0);
    await expect(page.getByText('存储管理', { exact: true })).toHaveCount(0);
    await page.getByTestId('settings-search').fill('');
    await expect(page.getByTestId('settings-nav-keyboard')).toBeVisible();
    await expect(page.getByTestId('settings-nav-sharing')).toHaveCount(0);
    await expect(page.getByText('CodeBuddy 服务器', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('settings.png') });
  } finally {
    await page.close();
  }
});

test('desktop categories, removed input settings, and model cards', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.goto(
      server.resolvedUrls!.local[0] + 'tests/browser-fixtures/settings-navigation.html'
    );
    await expect(page.getByTestId('settings-nav-input')).toHaveCount(0);
    const search = page.getByTestId('settings-search');
    await search.fill('拼写');
    await expect(page.getByRole('navigation').getByRole('button')).toHaveCount(0);
    await search.fill('模型');
    await page.getByTestId('settings-nav-models').click();
    const connections = page.getByRole('button', { name: '模型与连接', exact: true });
    const subagents = page.getByRole('button', { name: '子 Agent', exact: true });
    await expect(connections).toBeVisible();
    await expect(subagents).toBeVisible();
    expect((await connections.boundingBox())!.y).toBe((await subagents.boundingBox())!.y);
    await page.screenshot({ path: test.info().outputPath('settings-desktop.png') });
    await page.getByTestId('settings-nav-chat').click();
    await expect(page.getByRole('button', { name: 'CodeBuddy 规则', exact: true })).toBeVisible();
    const display = page.getByRole('button', { name: '工具过程显示', exact: true });
    await display.click();
    await expect(display).toBeHidden();
    await page.getByRole('button', { name: '返回菜单' }).click();
    await expect(display).toBeFocused();
  } finally {
    await page.close();
  }
});

test('compact settings reserve the width for content and support keyboard dismissal', async () => {
  const page = await browser.newPage({
    viewport: { width: 480, height: 740 },
    colorScheme: 'dark',
  });
  try {
    await page.goto(
      server.resolvedUrls!.local[0] + 'tests/browser-fixtures/settings-navigation.html'
    );
    const toggle = page.locator('button[aria-controls="settings-category-nav"]');
    const nav = page.getByRole('navigation');
    await expect(toggle).toBeVisible();
    await expect(nav).toBeHidden();
    await toggle.click();
    await expect(nav).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(nav).toBeHidden();
    await expect(toggle).toBeFocused();
    await page.getByTestId('settings-search').fill('模型');
    await page.getByTestId('settings-nav-models').click();
    await expect(nav).toBeHidden();
    await expect(toggle).toHaveAccessibleName('模型与运行');
    const cards = page.getByRole('main').getByRole('button');
    const first = await cards.first().boundingBox();
    const second = await cards.nth(1).boundingBox();
    expect(second!.y).toBeGreaterThan(first!.y);
    const overflow = await page
      .getByRole('main')
      .evaluate((main) =>
        Array.from(main.querySelectorAll('button')).some(
          (button) => button.getBoundingClientRect().right > main.getBoundingClientRect().right
        )
      );
    expect(overflow).toBe(false);
    await page.screenshot({ path: test.info().outputPath('settings-compact.png') });
  } finally {
    await page.close();
  }
});
