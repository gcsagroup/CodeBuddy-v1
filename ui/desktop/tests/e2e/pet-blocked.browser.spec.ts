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
    await page.getByRole('button', { name: 'blocked', exact: true }).click();
    await expect(canvas).not.toHaveClass('pet-breathing');
    await page.screenshot({ path: test.info().outputPath('blocked.png') });
    await page.clock.runFor(1100);
    await expect(canvas).toHaveClass('pet-breathing');
    await expect(page.getByText('Blocked · click to view')).toBeVisible();
    await page.getByRole('button', { name: 'blocked', exact: true }).click();
    await expect(canvas).toHaveClass('pet-breathing');
    await page.clock.runFor(10000);
    await expect(canvas).toHaveClass('pet-breathing');
    await page.screenshot({ path: test.info().outputPath('settled.png') });
    await canvas.click();
    await page.clock.runFor(310);
    await page.getByRole('textbox').fill('browser draft');
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
