import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve, dirname, basename } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let cacheDirectory: string;
const cacheRoot = resolve('../../.local');
test.beforeAll(async () => {
  await mkdir(cacheRoot, { recursive: true });
  server = await createServer({
    configFile: resolve('vite.renderer.config.mts'),
    cacheDir: (cacheDirectory = await mkdtemp(resolve(cacheRoot, 'compaction-settings-vite-'))),
    optimizeDeps: { entries: ['tests/browser-fixtures/compaction-settings.html'] },
    plugins: [
      {
        name: 'isolated-compaction-settings-bridge',
        enforce: 'pre',
        load(id) {
          if (!id.replaceAll('\\', '/').endsWith('/src/acp/config.ts')) return;
          // Only the settings transport is mocked; render the production component.
          return `export async function acpReadConfig() {
          const saved = localStorage.getItem('compaction-settings-fixture');
          return saved === null ? null : JSON.parse(saved);
        }
        export async function acpUpsertConfig(key, value) {
          if (key !== 'compactionModel') throw Error('Unexpected settings mutation');
          localStorage.setItem('compaction-settings-fixture', JSON.stringify(value));
        }`;
        },
      },
    ],
    server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  await server.listen();
  browser = await chromium.launch({
    channel:
      process.platform === 'win32'
        ? 'msedge'
        : process.platform === 'darwin'
          ? 'chrome'
          : undefined,
  });
  page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
});
test.afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (
    cacheDirectory &&
    dirname(resolve(cacheDirectory)) === cacheRoot &&
    basename(cacheDirectory).startsWith('compaction-settings-vite-')
  )
    await rm(cacheDirectory, { recursive: true, force: true });
});

test('compaction settings save an independent choice and restore following without changing other settings', async () => {
  await page.goto(
    `${server.resolvedUrls!.local[0]}tests/browser-fixtures/compaction-settings.html`
  );
  const select = page.getByRole('combobox', { name: '压缩模型' });
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue('');
  const choice = JSON.stringify(['local', 'gemma-4-26B-A4B-it-uncensored-FP8-W8A16']);
  await select.selectOption(choice);
  await page.getByRole('button', { name: '保存压缩模型' }).click();
  await expect(page.getByRole('status')).toHaveText('已保存，后续请求和手动压缩使用此设置。');
  await page.reload();
  await expect(select).toHaveValue(choice);
  await page.screenshot({ path: resolve('../../.local/compaction-settings-light.png') });
  await select.selectOption('');
  await page.getByRole('button', { name: '保存压缩模型' }).click();
  await page.reload();
  await expect(select).toHaveValue('');
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('compaction-settings-fixture')!))
  ).toBeNull();
});

test('an unavailable saved model remains explicit and the settings fit a narrow dark window', async () => {
  await page.setViewportSize({ width: 360, height: 760 });
  await page.evaluate(() =>
    localStorage.setItem(
      'compaction-settings-fixture',
      JSON.stringify({ providerId: 'removed', modelId: 'old-model' })
    )
  );
  await page.goto(
    `${server.resolvedUrls!.local[0]}tests/browser-fixtures/compaction-settings.html?dark`
  );
  await expect(page.getByRole('status')).toHaveText(
    '已保存的模型不可用，请重新选择，或改为跟随当前对话模型。'
  );
  await expect(page.getByRole('button', { name: '保存压缩模型' })).toBeDisabled();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: resolve('../../.local/compaction-settings-dark-narrow.png') });
  await page.getByRole('combobox', { name: '压缩模型' }).selectOption('');
  await page.getByRole('button', { name: '保存压缩模型' }).click();
  await expect(page.getByRole('status')).toHaveText('已保存，后续请求和手动压缩使用此设置。');
});
