import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

let server: ViteDevServer;
let browser: Browser;
let page: Page;
test.beforeAll(async () => {
  server = await createServer({
    configFile: resolve('vite.renderer.config.mts'),
    cacheDir: await mkdtemp(resolve(tmpdir(), 'codepro-stream-vite-')),
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
});
test.afterAll(async () => {
  await browser?.close();
  await server?.close();
});
test.beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
  await page.goto(`${server.resolvedUrls!.local[0]}tests/browser-fixtures/streaming.html`);
  await page.getByRole('button', { name: 'Latest' }).click();
  await page.waitForTimeout(200);
});
test.afterEach(async () => {
  await page.close();
});

test('long HTML code stream records render cost and remains complete', async () => {
  await page.goto(
    `${server.resolvedUrls!.local[0]}tests/browser-fixtures/streaming.html?long-code`
  );
  await page.evaluate(() => {
    const durations: number[] = [];
    Object.assign(window, { longTasks: durations });
    new window.PerformanceObserver((list) =>
      durations.push(...list.getEntries().map((e) => e.duration))
    ).observe({ type: 'longtask', buffered: false });
  });
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByTestId('transport')).toHaveText('finished', { timeout: 60000 });
  await expect(page.getByTestId('body')).toContainText('const enemy139');
  const metrics = await page.evaluate(() => {
    const values = window as unknown as { streamRenderSamples: number[]; longTasks: number[] };
    const renders = values.streamRenderSamples.slice(2).sort((a, b) => a - b);
    return {
      count: renders.length,
      p95: renders[Math.floor(renders.length * 0.95)],
      max: Math.max(...renders),
      totalRenderMs: renders.reduce((a, b) => a + b, 0),
      longTasks: values.longTasks.length,
      longTaskMs: values.longTasks.reduce((a, b) => a + b, 0),
    };
  });
  console.log('LONG_CODE_METRICS', JSON.stringify(metrics));
  await test.info().attach('long-code-metrics', {
    body: JSON.stringify(metrics),
    contentType: 'application/json',
  });
});

test('bursty input renders without a playback backlog while table columns stay stable', async () => {
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const samples = await page.evaluate(async () => {
    const body = document.querySelector('[data-testid="body"]')!;
    const viewport = document.querySelector('[data-radix-scroll-area-viewport]')!;
    const samples: {
      at: number;
      visible: number;
      received: number;
      rendered: number;
      top: number;
      columns: number[];
    }[] = [];
    const start = window.performance.now();
    await new Promise<void>((resolve) => {
      const sample = () => {
        samples.push({
          at: window.performance.now() - start,
          visible: Number(body.getAttribute('data-visible')),
          received: Number(body.getAttribute('data-received')),
          rendered: body.textContent?.length ?? 0,
          top: viewport.scrollTop,
          columns: Array.from(body.querySelectorAll('th')).map(
            (th) => th.getBoundingClientRect().width
          ),
        });
        if (window.performance.now() - start < 6500) requestAnimationFrame(sample);
        else resolve();
      };
      requestAnimationFrame(sample);
    });
    return samples;
  });
  await expect(page.getByTestId('transport')).toHaveText('finished', { timeout: 15000 });
  const received = Number(await page.getByTestId('body').getAttribute('data-received'));
  expect(Number(await page.getByTestId('body').getAttribute('data-visible'))).toBe(received);
  expect(samples.every((sample) => sample.visible === sample.received)).toBe(true);
  expect(samples.at(-1)!.visible).toBeGreaterThan(200);
  expect(samples.at(-1)!.top).toBeGreaterThan(samples[0].top);
  await expect(page.getByTestId('body')).toContainText('读者向上滚动时，不再追赶最新位置。');
  const tables = samples.filter((x) => x.columns.length === 3);
  expect(tables.length).toBeGreaterThan(20);
  for (let col = 0; col < 3; col++) {
    expect(
      Math.max(...tables.map((x) => x.columns[col])) -
        Math.min(...tables.map((x) => x.columns[col]))
    ).toBeLessThan(2);
  }
  await page.screenshot({ path: test.info().outputPath('paced-stream.png') });
  await test
    .info()
    .attach('frame-samples', { body: JSON.stringify(samples), contentType: 'application/json' });
});

test('scrolling up cancels automatic following while text keeps arriving', async () => {
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.waitForTimeout(3500);
  const viewport = page.locator('[data-radix-scroll-area-viewport]');
  await viewport.hover();
  await page.mouse.wheel(0, -220);
  await page.waitForTimeout(250);
  const before = await viewport.evaluate((el) => el.scrollTop);
  const textBefore = Number(await page.getByTestId('body').getAttribute('data-visible'));
  await page.waitForTimeout(1400);
  expect(Math.abs((await viewport.evaluate((el) => el.scrollTop)) - before)).toBeLessThan(2);
  expect(Number(await page.getByTestId('body').getAttribute('data-visible'))).toBeGreaterThan(
    textBefore
  );
});

test('completed copy and token usage stay visible and aligned without hover', async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}tests/browser-fixtures/streaming.html?footer`);
  const group = page.locator('.codepro-message-actions');
  const copy = group.getByRole('button', { name: 'Copy', exact: true });
  const usage = group.getByText('Input 1.2k');
  await expect(copy).toHaveCount(1);
  await expect(usage).toHaveCount(1);
  await expect(group).toHaveCSS('opacity', '1');
  await page.getByText('Finished answer', { exact: true }).hover();
  await expect(group).toHaveCSS('opacity', '1');
  const c = (await copy.boundingBox())!;
  const u = (await usage.boundingBox())!;
  expect(Math.abs(c.y + c.height / 2 - (u.y + u.height / 2))).toBeLessThanOrEqual(2);
  await page.mouse.move(950, 700);
  await expect(group).toHaveCSS('opacity', '1');
  await copy.focus();
  await expect(group).toHaveCSS('opacity', '1');
  await page.goto(`${server.resolvedUrls!.local[0]}tests/browser-fixtures/streaming.html?footer-stop`);
  await expect(page.getByText('Finished answer', { exact: true })).toBeVisible();
  await expect(group).toHaveCount(1);
  await expect(group.getByText('Output 340')).toBeVisible();
  await page.getByRole('button', { name: /Stopped after/ }).click();
  await expect(page.getByText('Checking the workspace', { exact: true })).toBeVisible();
  await expect(group).toHaveCount(1);
});
