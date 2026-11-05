import { chromium, expect, test, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve, dirname, basename } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
let server: ViteDevServer;
let browser: Browser;
let cache: string;
test.beforeAll(async () => {
  cache = await mkdtemp(resolve(tmpdir(), 'codebuddy-local-files-vite-'));
  server = await createServer({
    configFile: resolve('vite.renderer.config.mts'),
    cacheDir: cache,
    optimizeDeps: {
      entries: [
        'tests/browser-fixtures/local-files.html',
        'tests/browser-fixtures/conversation-timeline.html',
      ],
    },
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
    basename(cache).startsWith('codebuddy-local-files-vite-')
  ) {
    await rm(cache, { recursive: true, force: true });
  }
});
test('file controls belong to the file view and open the current target at every panel width', async () => {
  const page = await browser.newPage();
  await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/local-files.html');
  for (const width of [320, 480, 600, 900]) {
    await page.setViewportSize({ width, height: 720 });
    const nav = await page.getByRole('button', { name: 'Expand navigation' }).boundingBox();
    const start = await page.getByRole('tab', { name: 'New tab', exact: true }).boundingBox();
    expect(start!.y).toBeGreaterThanOrEqual(nav!.y + nav!.height);
    await page.getByRole('button', { name: 'New tab', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open with', exact: true })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Files', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: /Workspace files.*Browse/ }).click();
    await expect(page.getByRole('tab', { name: 'Files', exact: true })).toBeVisible();
    await expect(page.getByRole('tab').nth(0)).toHaveAccessibleName('Changes');
    await expect(page.getByRole('tab').nth(1)).toHaveAccessibleName('Subagents');
    await expect(page.getByRole('tab').nth(2)).toHaveAccessibleName('Files');
    await page.keyboard.press('Control+p');
    const search = page.getByRole('textbox', { name: 'Search filenames' });
    await expect(search).toBeFocused();
    await search.fill('missing-file');
    await expect(page.getByRole('button', { name: '中文测试文件.txt', exact: true })).toHaveCount(0);
    await search.fill('中文');
    await expect(page.getByRole('button', { name: '中文测试文件.txt', exact: true })).toBeVisible();
    await page.screenshot({ path: `../../.local/restoration-review/file-search-${width}.png` });
    await search.press('Escape');
    await expect(search).toHaveValue('');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    if (width === 600)
      await page.screenshot({
        path: '../../.local/right-panel-acceptance-20261104/narrow-files.png',
      });
    await page.getByRole('button', { name: 'Open in default application' }).click();
    await expect
      .poll(() => page.evaluate(() => JSON.parse(document.documentElement.dataset.openReceipt!)))
      .toMatchObject({ action: 'open-target', path: '', choose: false });
    await page.getByRole('button', { name: 'Open with', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => JSON.parse(document.documentElement.dataset.openReceipt!)))
      .toMatchObject({ path: '', choose: true });
    await page.getByRole('button', { name: '中文测试文件.txt', exact: true }).click();
    await expect(page.getByText('FILE-PREVIEW-OK')).toBeVisible();
    await page.getByRole('button', { name: 'Open with', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => JSON.parse(document.documentElement.dataset.openReceipt!)))
      .toMatchObject({ path: '中文测试文件.txt', choose: true });
    await page.getByRole('button', { name: 'Workspace file tree', exact: true }).click();
    // Every toolbar control must remain in its pane, including split file previews.
    const overflow = await page.locator('.wb-toolbar').evaluateAll((bars) =>
      bars.some((bar) => {
        const outer = bar.getBoundingClientRect();
        return Array.from(bar.querySelectorAll('button')).some((button) => {
          const box = button.getBoundingClientRect();
          return box.right > outer.right + 1 || box.left < outer.left - 1;
        });
      })
    );
    expect(overflow).toBe(false);
    await page.getByRole('button', { name: 'Workspace file tree', exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width
    );
    await page.getByRole('button', { name: 'Close 中文测试文件.txt', exact: true }).click();
    await page.getByRole('button', { name: 'Close Files', exact: true }).click();
  }
  await page.screenshot({
    path: '../../.local/right-panel-acceptance-20261104/contextual-file-panel.png',
  });
  await page.close();
});

test('timeline previews and jumps to an old unmounted turn without covering narrow chat content', async () => {
  const page = await browser.newPage({ viewport: { width: 600, height: 720 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    server.resolvedUrls!.local[0] + 'tests/browser-fixtures/conversation-timeline.html'
  );
  const first = page.getByRole('button', { name: 'Go to turn 1: Question 1', exact: true });
  await expect(first).toBeVisible();
  await expect(first.locator('span')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.locator('[data-chat-turn-id="message-0"]')).toHaveCount(0);
  await first.hover();
  await expect(page.getByRole('tooltip')).toContainText('Reply for turn 1.');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await first.click();
  const anchor = page.locator('[data-chat-turn-id="message-0"]');
  await expect(anchor).toBeVisible();
  await expect.poll(async () => (await anchor.boundingBox())!.y).toBeGreaterThanOrEqual(0);
  await expect.poll(async () => (await anchor.boundingBox())!.y).toBeLessThan(40);
  // At desktop width three complete/partial turns fit; all their ticks must be dark.
  await expect(page.locator('.conversation-timeline-tick[data-visible="true"]')).toHaveCount(3);
  const initialHighlights = await page
    .locator('.conversation-timeline-tick[data-visible="true"]')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label')));
  await page.getByRole('button', { name: 'Go to turn 25: Question 25', exact: true }).click();
  await expect
    .poll(async () => (await page.locator('[data-chat-turn-id="message-48"]').boundingBox())!.y)
    .toBeLessThan(40);
  await expect
    .poll(() =>
      page
        .locator('.conversation-timeline-tick[data-visible="true"]')
        .evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label')))
    )
    .not.toEqual(initialHighlights);
  await page.setViewportSize({ width: 360, height: 640 });
  await expect(page.locator('.conversation-timeline-tick[data-visible="true"]')).toHaveCount(2);
  await first.focus();
  await expect(page.getByRole('tooltip')).toContainText('Question 1');
  await expect(page.locator('.conversation-timeline-preview')).toHaveCSS('opacity', '1');
  await page.screenshot({
    path: '../../.local/right-panel-acceptance-20261104/conversation-timeline.png',
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  expect(errors).toEqual([]);
  await page.close();
});
