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
    cacheDir: (cacheDirectory = await mkdtemp(resolve(tmpdir(), 'codebuddy-advice-vite-'))),
    server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  await server.listen();
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome' });
});

for (const [locale, labels] of Object.entries({
  'zh-CN': ['详情', '继续等待', '停止并选择模型', '正在停止…'],
  'zh-TW': ['詳情', '繼續等待', '停止並選擇模型', '正在停止…'],
  en: ['Details', 'Keep waiting', 'Stop and choose a model', 'Stopping…'],
})) {
  test(`compact advice layout and actions in ${locale}`, async () => {
    const page = await browser.newPage();
    try {
      for (const width of [1280, 360]) {
        await page.setViewportSize({ width, height: 720 });
        await page.goto(`${server.resolvedUrls!.local[0]}tests/browser-fixtures/run-advice.html?locale=${locale}`);
        const card = page.getByRole('complementary');
        await expect(card).toBeVisible();
        await expect(page.getByText('正在重试模型请求', {exact:false})).not.toBeVisible();
        const size = await card.boundingBox();
        expect(size!.height).toBeLessThan(width === 360 ? 185 : 140);
        expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await page.screenshot({path:test.info().outputPath(`${locale}-${width}.png`)});
        const details = page.getByRole('button',{name:labels[0],exact:true});
        await details.focus(); await page.keyboard.press('Enter');
        await expect(details).toHaveAttribute('aria-expanded','true');
        await expect(page.getByText('正在重试模型请求', {exact:false})).toBeVisible();
        await page.getByRole('button',{name:labels[1],exact:true}).click();
        await expect(card).toHaveCount(0);
        await expect(page.getByRole('status')).toContainText('3/5');
        await expect(page.getByTestId('stops')).toHaveText('0');
        for(const kind of ['tools','waiting','generation','responses']) {
          await page.getByRole('button',{name:kind,exact:true}).click();
          await expect(card).toBeVisible();
          expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        }
        await page.getByRole('button',{name:'theme',exact:true}).click();
        await page.screenshot({path:test.info().outputPath(`${locale}-${width}-dark.png`)});
        await page.getByRole('button',{name:labels[2],exact:true}).click();
        await expect(page.getByTestId('stops')).toHaveText('1');
        await expect(page.getByRole('button',{name:labels[1],exact:true})).toBeDisabled();
      }
    } finally { await page.close(); }
  });
}

test.afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (
    cacheDirectory &&
    dirname(resolve(cacheDirectory)) === resolve(tmpdir()) &&
    basename(cacheDirectory).startsWith('codebuddy-advice-vite-')
  )
    await rm(cacheDirectory, { recursive: true, force: true });
});

