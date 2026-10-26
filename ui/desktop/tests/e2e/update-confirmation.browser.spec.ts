import { chromium, expect, test } from '@playwright/test';
import { createServer } from 'vite';
import { resolve, dirname, basename } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

test('downloaded update explains interruption, stays ready after Later and shows saving progress', async () => {
  const cache = await mkdtemp(resolve(tmpdir(), 'codebuddy-update-vite-'));
  const server = await createServer({ configFile: resolve('vite.renderer.config.mts'), cacheDir: cache,
    server: { host: '127.0.0.1', port: 0, hmr: false } });
  const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
  try {
    await server.listen();
    const page = await browser.newPage({ viewport: { width: 1000, height: 740 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/update-confirmation.html');
    await expect(page.getByRole('status')).toContainText('重启会停止当前任务');
    await page.getByRole('button', { name: '重启并更新', exact: true }).click();
    await expect(page.getByRole('button', { name: '重启并更新', exact: true })).toBeEnabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('update-ready.png') });
    await page.getByRole('button', { name: '重启并更新', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('停止任务并保存记录');
    await expect(page.getByRole('button', { name: '检查更新', exact: true })).toBeDisabled();
    expect(errors).toEqual([]);
  } finally {
    await browser.close(); await server.close();
    if (dirname(resolve(cache)) === resolve(tmpdir()) && basename(cache).startsWith('codebuddy-update-vite-'))
      await rm(cache, { recursive: true, force: true });
  }
});
