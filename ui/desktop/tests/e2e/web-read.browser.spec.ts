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


for (const [label, expected] of [['本会话允许网页读取', 'session'], ['仅此次允许', 'once'], ['拒绝', 'reject']]) {
  test('public web approval and discovery display: '+expected, async () => {
    const page=await browser.newPage();
    const errors:string[]=[]; page.on('pageerror',error=>{errors.push(error.message); console.error('Fixture page error:',error.message);});
    try {
      await page.goto(server.resolvedUrls!.local[0]+'tests/browser-fixtures/web-read.html', {timeout:60000});
      await expect(page.getByRole('button',{name:'深度思考',exact:true})).toHaveCount(2);
      await expect(page.getByText('正在查找可用工具',{exact:true})).toBeVisible();
      await page.getByRole('button',{name:'深度思考',exact:true}).first().click();
      await expect(page.getByText(/第一段分析。/)).toContainText('继续分析。');
      await expect(page.getByText(/允许本会话跨网站匿名读取公开网页/)).toBeVisible();
      await page.getByRole('button',{name:label,exact:true}).click();
      await expect(page.locator('#receipt')).toContainText('"optionId":"'+expected+'"');
      await page.screenshot({path:test.info().outputPath('web-read-'+expected+'.png'), fullPage:true});
      expect(errors).toEqual([]);
    } finally {await page.close();}
  });
}
