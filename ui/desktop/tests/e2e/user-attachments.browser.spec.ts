import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { basename, dirname, resolve } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let cacheDirectory: string;
const cacheRoot = resolve('../../.local');

test.beforeAll(async () => {
  await mkdir(cacheRoot, { recursive: true });
  cacheDirectory = await mkdtemp(resolve(cacheRoot, 'user-attachments-vite-'));
  server = await createServer({
    configFile: resolve('vite.renderer.config.mts'),
    cacheDir: cacheDirectory,
    optimizeDeps: { entries: ['tests/browser-fixtures/user-attachments.html'] },
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
  page = await browser.newPage({ viewport: { width: 1000, height: 1100 } });
});

test.afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (
    cacheDirectory &&
    dirname(resolve(cacheDirectory)) === cacheRoot &&
    basename(cacheDirectory).startsWith('user-attachments-vite-')
  )
    await rm(cacheDirectory, { recursive: true, force: true });
});

const visit = (query = '') =>
  page.goto(`${server.resolvedUrls!.local[0]}tests/browser-fixtures/user-attachments.html${query}`);
const example = (name: string) => page.locator(`[data-case="${name}"]`);

test('attachments sit above an independent text bubble and retain the image lightbox', async () => {
  await visit();
  const item = example('attachments');
  const strip = item.getByTestId('user-message-attachments');
  const bubble = item.getByTestId('user-message-bubble');
  const previews = strip.getByRole('button', { name: 'Click to expand' });
  await expect(previews).toHaveCount(5);
  const stripBox = (await strip.boundingBox())!;
  const bubbleBox = (await bubble.boundingBox())!;
  const plainBox = (await example('plain').getByTestId('user-message-bubble').boundingBox())!;
  expect(stripBox.y + stripBox.height).toBeLessThanOrEqual(bubbleBox.y);
  expect(Math.abs(bubbleBox.width - plainBox.width)).toBeLessThanOrEqual(1);
  expect(bubbleBox.width).toBeLessThan(stripBox.width / 2);
  expect(Math.abs(bubbleBox.x + bubbleBox.width - stripBox.x - stripBox.width)).toBeLessThanOrEqual(
    1
  );
  for (const preview of await previews.all()) {
    const box = (await preview.boundingBox())!;
    expect(box.width).toBe(80);
    expect(box.height).toBe(80);
  }
  await page.screenshot({
    path: resolve('../../.local/user-attachments-light.png'),
    fullPage: true,
  });
  const trigger = previews.first();
  const source = await trigger.locator('img').getAttribute('src');
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('img')).toHaveAttribute('src', source!);
  await dialog.getByRole('button', { name: 'Zoom in' }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test('narrow dark windows keep a scrollable single row without widening the page', async () => {
  await page.setViewportSize({ width: 360, height: 1100 });
  await visit('?dark');
  const strip = example('overflow').getByTestId('user-message-attachments');
  const previews = strip.getByRole('button', { name: 'Click to expand' });
  await expect(previews).toHaveCount(10);
  const positions = await previews.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().top)
  );
  expect(Math.max(...positions) - Math.min(...positions)).toBeLessThanOrEqual(1);
  expect(await strip.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
  ).toBeLessThanOrEqual(1);
  await previews.last().focus();
  expect(await strip.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  const last = (await previews.last().boundingBox())!;
  const row = (await strip.boundingBox())!;
  expect(last.x + last.width).toBeLessThanOrEqual(row.x + row.width + 1);
  await page.screenshot({
    path: resolve('../../.local/user-attachments-dark-narrow.png'),
    fullPage: true,
  });
});

test('image-only, failed images, long text and ordinary inline previews retain their boundaries', async () => {
  await page.setViewportSize({ width: 1000, height: 1100 });
  await visit();
  await expect(example('image-only').getByTestId('user-message-bubble')).toHaveCount(0);
  await expect(
    example('image-only').getByRole('button', { name: 'Click to expand' })
  ).toBeVisible();
  const failure = example('failed-image').getByText('Unable to load image');
  await expect(failure).toBeVisible();
  const failureBox = (await failure.boundingBox())!;
  expect(failureBox.width).toBe(80);
  expect(failureBox.height).toBe(80);
  const bubble = example('long-text').getByTestId('user-message-bubble');
  expect((await bubble.boundingBox())!.width).toBeLessThanOrEqual(
    (await example('long-text').boundingBox())!.width * 0.85 + 1
  );
  const ordinary = example('inline-preview').getByRole('img');
  await expect(ordinary).toBeVisible();
  expect((await ordinary.boundingBox())!.height).toBeGreaterThan(80);
  expect((await ordinary.boundingBox())!.height).toBeLessThanOrEqual(160);
});
