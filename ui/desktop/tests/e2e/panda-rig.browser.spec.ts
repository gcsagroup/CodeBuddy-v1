import { chromium, expect, test } from '@playwright/test';
import { createServer } from 'vite';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

test('panda sample: real renderer interactions, recording, reduced motion and frame budget', async () => {
  test.setTimeout(100_000);
  const evidence = test.info().outputPath('panda-rig-review');
  await mkdir(evidence, { recursive: true });
  const server = await createServer({
    configFile: resolve('vite.renderer.config.mts'),
    cacheDir: resolve('.local/panda-rig-test-cache'),
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  });
  await server.listen();
  const browser = await chromium.launch({
    channel: process.platform === 'win32' ? 'msedge' : undefined,
  });
  const context = await browser.newContext({
    viewport: { width: 1100, height: 870 },
    deviceScaleFactor: 2,
    recordVideo: { dir: evidence, size: { width: 1100, height: 870 } },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const video = page.video()!;
  const cdp = await context.newCDPSession(page);
  const report = async () =>
    page.evaluate(() => (window as unknown as { pandaReports: unknown[] }).pandaReports);
  try {
    await page.goto(`${server.resolvedUrls!.local[0]}src/pets/prototype/preview.html`);
    const canvas = page.getByRole('img', { name: '小熊猫分层动画' });
    await expect(canvas).toHaveAttribute('data-ready', 'true');
    await cdp.send('Performance.enable');
    const memoryStart = await cdp.send('Performance.getMetrics');
    // Record the same actual renderer the user will see. No synthetic animation clock.
    await page.waitForTimeout(4200);
    await page.getByRole('button', { name: '挥手', exact: true }).click();
    await expect(canvas).toHaveAttribute('data-action', 'wave');
    await page.waitForTimeout(1100);
    await page.screenshot({ path: resolve(evidence, 'wave.png') });
    await expect(canvas).toHaveAttribute('data-action', 'idle', { timeout: 4000 });
    await page.getByRole('button', { name: '观察', exact: true }).click();
    await page.mouse.move(820, 300, { steps: 20 });
    await page.waitForTimeout(1200);
    await page.mouse.move(260, 400, { steps: 25 });
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: '跳跃', exact: true }).click();
    await expect(canvas).toHaveAttribute('data-action', 'jump');
    await page.waitForTimeout(760);
    const topEdgeIsClear = await canvas.evaluate((node: HTMLCanvasElement) => {
      const pixels = node.getContext('2d')!.getImageData(0, 0, node.width, 2).data;
      return pixels.every((alpha, index) => index % 4 !== 3 || alpha === 0);
    });
    expect(topEdgeIsClear).toBe(true);
    await page.screenshot({ path: resolve(evidence, 'jump.png') });
    await expect(canvas).toHaveAttribute('data-action', 'idle', { timeout: 4000 });
    const normal = await report();
    const memoryEnd = await cdp.send('Performance.getMetrics');
    await page.screenshot({ path: resolve(evidence, 'preview.png') });
    // Exercise interruption through real controls, then measure at actual desktop size.
    await page.getByRole('button', { name: '挥手', exact: true }).click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: '跳跃', exact: true }).click();
    await expect(canvas).toHaveAttribute('data-action', 'idle', { timeout: 4000 });
    await page.getByLabel('桌面实际大小').check();
    await expect(canvas).toHaveCSS('width', '160px');
    const desktopStart = (await report()).length;
    await page.waitForTimeout(2200);
    const desktop = (await report()).slice(desktopStart);
    // Static mode must actually stop drawing, including blinks.
    await page.getByLabel('减少动画').check();
    const still = await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL());
    const before = (await report()).length;
    await page.waitForTimeout(1800);
    expect(await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL())).toBe(still);
    expect((await report()).length).toBe(before);
    await page.getByLabel('减少动画').uncheck();
    // This is browser CPU throttling, not a claim of testing a separate low-end PC.
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const stressStart = (await report()).length;
    await page.getByLabel('自动演示').check();
    await page.waitForTimeout(13500);
    const throttled = (await report()).slice(stressStart);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await page.getByLabel('自动演示').uncheck();
    await page.getByLabel('桌面实际大小').uncheck();
    await page.getByRole('button', { name: '待机', exact: true }).click();
    expect(errors).toEqual([]);
    const samples = [...normal, ...throttled] as Array<{ fps: number; drawP95: number }>;
    expect(samples.length).toBeGreaterThan(15);
    // A failed budget is evidence to investigate, never silently relabelled as smooth.
    expect(samples.filter((sample) => sample.drawP95 > 8)).toHaveLength(0);
    expect(samples.filter((sample) => sample.fps < 45).length).toBeLessThanOrEqual(1);
    await writeFile(
      resolve(evidence, 'performance.json'),
      JSON.stringify(
        {
          source: 'D:/CodeBuddy-v1 main b7865d54 + uncommitted prototype',
          browser: browser.version(),
          viewport: { width: 1100, height: 870 },
          dpr: 2,
          normal,
          desktop,
          throttled,
          memoryStart,
          memoryEnd,
          errors,
        },
        null,
        2
      )
    );
  } finally {
    await context.close();
    await video.saveAs(resolve(evidence, 'browser-recording.webm'));
    await browser.close();
    await server.close();
  }
});

test('panda frame pacing without recording or screenshots', async () => {
  test.setTimeout(80_000);
  const evidence = resolve('.local/panda-rig-review');
  await mkdir(evidence, { recursive: true });
  const server = await createServer({
    configFile: resolve('vite.renderer.config.mts'),
    cacheDir: resolve('.local/panda-rig-test-cache'),
    server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  await server.listen();
  const browser = await chromium.launch({
    channel: process.platform === 'win32' ? 'msedge' : undefined,
  });
  const context = await browser.newContext({
    viewport: { width: 1100, height: 870 },
    deviceScaleFactor: 2,
  });
  try {
    const page = await context.newPage();
    await page.goto(`${server.resolvedUrls!.local[0]}src/pets/prototype/preview.html`);
    await expect(page.locator('canvas')).toHaveAttribute('data-ready', 'true');
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const initial = await cdp.send('Performance.getMetrics');
    await page.getByLabel('自动演示').check();
    const sample = () =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              pandaReports: Array<{ fps: number; drawP95: number; frameP95: number }>;
            }
          ).pandaReports
      );
    await page.waitForTimeout(15000);
    const large = await sample();
    await page.getByLabel('桌面实际大小').check();
    const desktopStart = (await sample()).length;
    await page.waitForTimeout(10000);
    const desktop = (await sample()).slice(desktopStart);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const stressStart = (await sample()).length;
    await page.waitForTimeout(15000);
    const throttled = (await sample()).slice(stressStart);
    const final = await cdp.send('Performance.getMetrics');
    await writeFile(
      resolve(evidence, 'performance-unrecorded.json'),
      JSON.stringify(
        {
          browser: browser.version(),
          dpr: 2,
          large,
          desktop,
          throttled,
          initial,
          final,
          note: 'No video/screenshots; 320px 15s, 160px 10s, 160px CPU 4x 15s. Browser throttling is not separate hardware.',
        },
        null,
        2
      )
    );
    for (const phase of [large, desktop, throttled]) {
      expect(phase.length).toBeGreaterThanOrEqual(8);
      expect(phase.reduce((sum, sample) => sum + sample.fps, 0) / phase.length).toBeGreaterThan(50);
      expect(phase.every((sample) => sample.drawP95 < 8)).toBe(true);
    }
  } finally {
    await context.close();
    await browser.close();
    await server.close();
  }
});
