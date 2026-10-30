import { chromium, expect, test, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve, dirname, basename } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

let server: ViteDevServer;
let browser: Browser;
let cacheDirectory: string;

test.beforeAll(async () => {
  cacheDirectory = await mkdtemp(resolve(tmpdir(), 'codebuddy-media-library-vite-'));
  server = await createServer({
    configFile: resolve('vite.renderer.config.mts'),
    cacheDir: cacheDirectory,
    optimizeDeps: { entries: ['tests/browser-fixtures/media-library.html'] },
    resolve: { alias: [{ find: /.*\/acp\/acpConnection$/, replacement: resolve('tests/browser-fixtures/media-library-api.ts') }] },
    server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  await server.listen();
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
});

test.afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (cacheDirectory && dirname(resolve(cacheDirectory)) === resolve(tmpdir()) && basename(cacheDirectory).startsWith('codebuddy-media-library-vite-'))
    await rm(cacheDirectory, { recursive: true, force: true });
});

test('media library layout, image preview, filters and source navigation', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', error => console.error(error));
  try {
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/media-library.html');
    await expect(page.getByRole('heading', { name: '素材库' })).toBeVisible();
    await expect(page.locator('article')).toHaveCount(3);
    const picture = page.getByRole('img', { name: '远山与湖泊', exact: true });
    await expect(picture).toBeVisible();
    await expect(picture).toHaveJSProperty('complete', true);
    await expect(page.getByText('文件不可用，可能已移动或删除。')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('media-library-desktop.png') });
    await picture.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByLabel('项目', { exact: true }).selectOption('C:/projects/product');
    await expect(page.locator('article')).toHaveCount(2);
    await page.getByLabel('素材类型').selectOption('video');
    await expect(page.locator('article')).toHaveCount(1);
    await expect(page.getByRole('button', { name: '打开文件位置' })).toBeDisabled();
    await page.getByLabel('素材类型').selectOption('all');
    await page.getByLabel('项目', { exact: true }).selectOption('');
    await page.getByLabel('搜索素材').fill('远山');
    await expect(page.locator('article')).toHaveCount(1);
    await page.getByRole('button', { name: '来源对话' }).click();
    await expect(page.getByTestId('location')).not.toHaveText('/media-library');
    await page.getByLabel('搜索素材').fill('');
    await expect(page.locator('article')).toHaveCount(3);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('heading', { name: '素材库' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('media-library-narrow.png') });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/media-library.html?dark');
    await expect(page.getByRole('img', { name: '远山与湖泊', exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('media-library-dark.png') });
    await expect(page.getByTestId('library-summary')).toContainText('4.0 KB');
    await page.getByLabel('视图', { exact: true }).selectOption('workspace');
    await expect(page.getByRole('region', { name: 'product', exact: true })).toContainText('2.0 KB');
    await page.screenshot({ path: test.info().outputPath('media-library-workspaces.png') });
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /删除选中/ })).toHaveCount(0);
    const card = page.getByRole('article', { name: '素材：远山与湖泊' });
    const bounds = (await card.boundingBox())!;
    await page.mouse.move(bounds.x + 30, bounds.y + 20);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 60, bounds.y + 20);
    await page.mouse.up();
    await page.waitForTimeout(550);
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    const holdCard = async () => {
      const box = (await picture.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(600);
      await page.mouse.up();
      await expect(page.getByRole('checkbox', { name: '选择 远山与湖泊' })).toBeChecked();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    };
    await holdCard();
    await page.getByRole('button', { name: '取消选择', exact: true }).click();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /删除选中/ })).toHaveCount(0);
    await holdCard();
    const landscapeGroup = page.getByRole('button', { name: '取消选择工作区 landscape', exact: true });
    await expect(landscapeGroup).toHaveText('−');
    await landscapeGroup.click();
    const selectLandscape = page.getByRole('button', { name: '选择工作区 landscape', exact: true });
    await expect(selectLandscape).toHaveText('+');
    await expect(page.getByRole('checkbox', { name: '选择 远山与湖泊' })).not.toBeChecked();
    await selectLandscape.click();
    await expect(page.getByRole('button', { name: '取消选择工作区 landscape', exact: true })).toHaveText('−');
    await page.screenshot({ path: test.info().outputPath('media-library-selection.png') });
    await page.getByRole('checkbox', { name: '选择 蓝色产品示意图' }).check();
    await page.getByRole('button', { name: '删除选中 (2)' }).click();
    await expect(page.getByRole('dialog')).toContainText('无法撤销');
    await expect(page.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    await page.screenshot({ path: test.info().outputPath('media-library-delete-confirmation.png') });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('article')).toHaveCount(3);
    await page.getByRole('button', { name: '删除选中 (2)' }).click();
    await page.getByRole('button', { name: '永久删除' }).click();
    await expect(page.locator('article')).toHaveCount(1);
    await expect(page.getByTestId('library-summary')).toContainText('0.0 KB');
    await expect(page.getByText('已删除 2', { exact: true })).toBeVisible();
  } finally { await page.close(); }
});
