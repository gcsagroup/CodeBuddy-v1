import { chromium, expect, test } from '@playwright/test';
import { createServer } from 'vite';
import { resolve, dirname, basename } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

test('blocked pet settles in the real renderer without clearing the task or replaying on snapshots', async () => {
  const cache = await mkdtemp(resolve(tmpdir(), 'codebuddy-pet-vite-'));
  const server = await createServer({
    configFile: resolve('vite.renderer.config.mts'),
    cacheDir: cache,
    server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  const browser = await chromium.launch({
    channel: process.platform === 'win32' ? 'msedge' : undefined,
  });
  try {
    await server.listen();
    const page = await browser.newPage({ locale: 'en-US' });
    await page.clock.install();
    await page.goto(`${server.resolvedUrls!.local[0]}tests/browser-fixtures/pet-blocked.html`);
    const canvas = page.getByRole('img', { name: 'Panda' });
    await expect(canvas).toBeVisible();
    await page.clock.pauseAt(new Date(Date.now() + 60_000));
    await page.getByRole('button', { name: 'working', exact: true }).click();
    await expect(canvas).toHaveAttribute('data-animation', 'working');
    await page.clock.runFor(2100);
    await expect(canvas).toHaveAttribute('data-animation', 'idle');
    const panel = page.locator('.pet-task-panel');
    await expect(page.getByText('Waiting for a reply', { exact: true })).toBeVisible();
    expect((await panel.boundingBox())!.height).toBeLessThan(64);
    await expect(panel).toHaveCSS('background-color', 'rgba(250, 252, 251, 0.77)');
    const spriteBox = (await canvas.boundingBox())!;
    const cardBox = (await panel.boundingBox())!;
    const topInset = await page.evaluate(async () => {
      const sheet = new Image();
      sheet.src = (await window.electron.desktopPet({ action: 'get' })).pets[0].imageUrl;
      await sheet.decode();
      const c = document.createElement('canvas');
      c.width = sheet.width;
      c.height = sheet.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(sheet, 0, 0);
      const rgba = ctx.getImageData(0, 0, c.width, c.height).data;
      let first = 208;
      for (let i = 3; i < 208 * c.width * 4; i += 4) {
        if (rgba[i] > 24) first = Math.min(first, Math.floor(i / 4 / c.width) % 208);
      }
      return first;
    });
    const gap = spriteBox.y + topInset * spriteBox.height / 208 - (cardBox.y + cardBox.height);
    expect(gap).toBeGreaterThanOrEqual(4.5);
    expect(gap).toBeLessThanOrEqual(5.5);
    await page.screenshot({ path: test.info().outputPath('spacing.png'), clip: {
      x: cardBox.x, y: cardBox.y, width: cardBox.width,
      height: Math.ceil(spriteBox.y + spriteBox.height - cardBox.y),
    } });
    await panel.screenshot({ path: test.info().outputPath('waiting.png') });
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.getByRole('button', { name: /^Blocked conversation/ }).click();
    const actions = await page.evaluate(() => (window as unknown as { petRequests: { action: string }[] }).petRequests.map(request => request.action));
    expect(actions).toContain('pause-task');
    expect(actions).toContain('open-task');
    await page.getByRole('button', { name: 'working', exact: true }).click();
    await expect(canvas).toHaveAttribute('data-animation', 'idle');
    // A settled idle must keep the actual canvas pixels still, not just its label.
    const idlePixels = await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL());
    await page.clock.runFor(2000);
    expect(await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL())).toBe(idlePixels);
    expect(await canvas.evaluate((node) => getComputedStyle(node).animationName)).toBe('none');
    for (const [state, animation] of [['input', 'waiting'], ['completed', 'review']]) {
      await page.getByRole('button', { name: state, exact: true }).click();
      await expect(canvas).toHaveAttribute('data-animation', animation);
      await page.clock.runFor(2100);
      await expect(canvas).toHaveAttribute('data-animation', 'idle');
    }
    await page.getByRole('button', { name: 'blocked', exact: true }).click();
    await expect(canvas).toHaveAttribute('data-animation', 'failed');
    await page.screenshot({ path: test.info().outputPath('blocked.png') });
    await page.clock.runFor(2100);
    await expect(canvas).toHaveAttribute('data-animation', 'idle');
    await expect(page.getByText('Blocked · click to view')).toBeVisible();
    await page.getByRole('button', { name: 'blocked', exact: true }).click();
    await expect(canvas).toHaveAttribute('data-animation', 'idle');
    await page.clock.runFor(10000);
    await expect(canvas).toHaveAttribute('data-animation', 'idle');
    await page.screenshot({ path: test.info().outputPath('settled.png') });
    await canvas.click();
    await page.clock.runFor(310);
    await page.getByRole('textbox').fill('browser draft');
    await page.clock.runFor(2200);
    const composerBox = (await page.locator('.pet-compose-panel').boundingBox())!;
    expect(Math.abs(composerBox.y + composerBox.height - cardBox.y - cardBox.height)).toBeLessThan(1);

    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(page.locator('.pet-compose-panel')).toHaveCSS('background-color',
        colorScheme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(34, 37, 42)');
      await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
      await page.locator('.pet-compose-panel').screenshot({ path: test.info().outputPath(`pet-chat-${colorScheme}.png`) });
    }
    await page.getByRole('button', { name: 'Add attachments or features' }).click();
    await expect(page.getByRole('button', { name: 'File', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Goal', exact: true }).click();
    const requests = await page.evaluate(() => (window as unknown as { petRequests: { action: string; message?: string; composerAction?: string }[] }).petRequests);
    expect(requests.some(request => request.action === 'send-message')).toBe(false);
    expect(requests).toContainEqual({ action: 'open-composer', composerAction: 'goal', message: 'browser draft' });

  } finally {
    await browser.close();
    await server.close();
    if (dirname(cache) === resolve(tmpdir()) && basename(cache).startsWith('codebuddy-pet-vite-'))
      await rm(cache, { recursive: true, force: true });
  }
});
