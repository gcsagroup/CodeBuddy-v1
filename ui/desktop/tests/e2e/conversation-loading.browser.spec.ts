import { chromium, expect, test, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve, dirname, basename } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

let browser: Browser, server: ViteDevServer, cache: string;
test.beforeAll(async () => {
  cache = await mkdtemp(resolve(tmpdir(), 'codebuddy-loading-'));
  server = await createServer({ configFile: resolve('vite.renderer.config.mts'), cacheDir: cache,
    optimizeDeps: { entries: ['tests/browser-fixtures/conversation-loading.html'], holdUntilCrawlEnd: false },
    server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen();
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
  browser.on('page', page => page.on('pageerror', error => console.error(error.message)));
});
test.afterAll(async () => {
  await browser?.close(); await server?.close();
  if (cache && dirname(resolve(cache)) === resolve(tmpdir()) && basename(cache).startsWith('codebuddy-loading-'))
    await rm(cache, { recursive: true, force: true });
});
for (const dark of [false, true]) test(`loading stays readable and centered (${dark ? 'dark' : 'light'})`, async () => {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  try {
    await page.goto(server.resolvedUrls!.local[0] + `tests/browser-fixtures/conversation-loading.html${dark ? '?dark' : ''}`);
    const status = page.getByRole('status');
    for (const width of [360, 1100]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(status).toHaveText('正在加载对话…');
      await expect(status).toBeVisible();
      const bounds = (await status.boundingBox())!;
      const area = (await page.getByTestId('conversation-area').boundingBox())!;
      expect(Math.abs(bounds.x + bounds.width / 2 - (area.x + area.width / 2))).toBeLessThan(2);
      expect(Math.abs(bounds.y + bounds.height / 2 - (area.y + area.height / 2))).toBeLessThan(2);
      await expect(status).toHaveCSS('font-size', '14px');
      await expect(status).toHaveCSS('opacity', '1');
      const brand = status.locator('.conversation-loading-brand');
      await expect(brand.locator('img')).toBeVisible();
      expect((await brand.boundingBox())!.width).toBe(44);
      expect((await brand.locator('img').boundingBox())!.width).toBe(28);
      expect(await brand.evaluate(element => getComputedStyle(element, '::before').animationName)).toBe('none');
    }
    await page.screenshot({ path: test.info().outputPath('loading.png') });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const brand = status.locator('.conversation-loading-brand');
    expect(await brand.evaluate(element => getComputedStyle(element, '::before').animationName)).toBe('conversation-loading-orbit');
    const firstTransform = await brand.evaluate(element => getComputedStyle(element, '::before').transform);
    await expect.poll(() => brand.evaluate(element => getComputedStyle(element, '::before').transform))
      .not.toBe(firstTransform);
    await page.getByRole('button', { name: '切换加载状态' }).click();
    await expect(status).toHaveCount(0);
    await expect(page.getByText('历史内容已显示')).toBeVisible();
    await page.getByRole('button', { name: '切换加载状态' }).click();
    await expect(status).toBeVisible();
  } finally { await page.close(); }
});

for (const dark of [false, true]) test(`startup uses a compact consistent brand (${dark ? 'dark' : 'light'})`, async () => {
  const page = await browser.newPage({reducedMotion: 'reduce'});
  try {
    await page.goto(server.resolvedUrls!.local[0] + `tests/browser-fixtures/conversation-loading.html?startup${dark ? '&dark' : ''}`);
    for (const width of [360, 1100]) {
      await page.setViewportSize({width, height: 800});
      const brand = page.locator('.conversation-loading-brand');
      expect((await brand.boundingBox())!.width).toBe(56);
      expect((await brand.locator('img').boundingBox())!.width).toBe(36);
      await expect(page.getByRole('heading')).toHaveCSS('font-size','14px');
      const box = (await brand.boundingBox())!;
      expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThan(2);
      const content = (await page.getByRole('status').boundingBox())!;
      const area = (await page.getByTestId('conversation-area').boundingBox())!;
      expect(Math.abs(content.y + content.height / 2 - (area.y + area.height / 2))).toBeLessThan(2);
    }
    await page.screenshot({path:test.info().outputPath('startup-compact.png')});
  } finally { await page.close(); }
});

test('the initial HTML loading mark matches the compact startup screen', async () => {
  const page = await browser.newPage({viewport:{width:1100,height:800}});
  try {
    await page.route('**/src/renderer.tsx', route => route.abort());
    await page.goto(server.resolvedUrls!.local[0] + '#/codepro');
    const brand = page.locator('.first-paint .conversation-loading-brand');
    await expect(brand).toBeVisible();
    expect((await brand.boundingBox())!.width).toBe(56);
    expect((await brand.locator('img').boundingBox())!.width).toBe(36);
    await page.screenshot({path:test.info().outputPath('initial-paint-compact.png')});
  } finally {await page.close();}
});

test('startup stays vertically centered when React takes over the initial HTML', async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  let startRenderer!: () => void;
  const rendererReady = new Promise<void>(resolve => { startRenderer = resolve; });
  try {
    await page.route('**/src/renderer.tsx', async route => {
      await rendererReady;
      // Isolate the startup layout from Electron IPC and backend connections.
      await route.fulfill({ contentType: 'application/javascript',
        body: 'import "/tests/browser-fixtures/conversation-loading.tsx";' });
    });
    await page.goto(server.resolvedUrls!.local[0] + '?root-startup#/codepro', { waitUntil: 'commit' });
    const firstPaint = page.locator('.first-paint .startup-loader__content');
    await expect(firstPaint).toBeVisible();
    const initial = (await firstPaint.boundingBox())!;
    expect(Math.abs(initial.y + initial.height / 2 - 400)).toBeLessThan(2);
    startRenderer();
    const status = page.locator('.startup-loader__content[role="status"]');
    await expect(status).toBeVisible();
    await expect(page.locator('.first-paint')).toHaveCount(0);
    for (const viewport of [{ width: 1100, height: 800 }, { width: 360, height: 640 }]) {
      await page.setViewportSize(viewport);
      const box = (await status.boundingBox())!;
      await page.screenshot({ path: test.info().outputPath(`startup-react-${viewport.width}.png`) });
      expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(2);
      expect(Math.abs(box.y + box.height / 2 - viewport.height / 2)).toBeLessThan(2);
    }
  } finally {
    startRenderer();
    await page.close();
  }
});
