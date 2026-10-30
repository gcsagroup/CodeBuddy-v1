import { chromium, expect, test, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve, dirname, basename } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

let server: ViteDevServer;
let browser: Browser;
let cacheDirectory: string;
test.beforeAll(async () => {
  cacheDirectory = await mkdtemp(resolve(tmpdir(), 'codebuddy-copy-vite-'));
  server = await createServer({
    configFile: resolve('vite.renderer.config.mts'),
    cacheDir: cacheDirectory,
    server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  await server.listen();
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
});
test.afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (
    cacheDirectory &&
    dirname(resolve(cacheDirectory)) === resolve(tmpdir()) &&
    basename(cacheDirectory).startsWith('codebuddy-copy-vite-')
  ) {
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});

for (const [name, text] of [
  [
    'adjacent Chinese URL',
    'https://github.com/Panniatong/Agent-Reach分析一下和这个网址里面的是什么',
  ],
  [
    'source whitespace and Markdown',
    '  中文 🙂\n[文档](https://example.com/文档?q=中文)\n`code`  ',
  ],
]) {
  test(`user copy roundtrips ${name} through the browser clipboard`, async () => {
    const context = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto(
        server.resolvedUrls!.local[0] +
          'tests/browser-fixtures/message-copy.html?text=' +
          encodeURIComponent(text),
        { timeout: 60000 }
      );
      await page.getByRole('button', { name: 'Copy', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Copy', exact: true })).toHaveText('Copied!');
      // Windows clipboard transport uses CRLF; the textarea restores LF on paste.
      expect(
        (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')
      ).toBe(text);
      const formats = await page.evaluate(async () =>
        (await navigator.clipboard.read()).flatMap((item) => item.types)
      );
      expect(formats).toContain('text/plain');
      expect(formats).not.toContain('text/html');
      await page.getByLabel('Paste result').focus();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
      await expect(page.getByLabel('Paste result')).toHaveValue(text);
      await page.screenshot({ path: test.info().outputPath('copy-paste.png'), fullPage: true });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}
