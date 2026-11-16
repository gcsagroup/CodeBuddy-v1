import { chromium, expect, test, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve, dirname, basename } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

let server: ViteDevServer;
let browser: Browser;
let cacheDirectory: string;

test.beforeAll(async () => {
  server = await createServer({
    configFile: resolve('vite.renderer.config.mts'),
    cacheDir: (cacheDirectory = await mkdtemp(resolve(tmpdir(), 'codebuddy-status-vite-'))),
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
    basename(cacheDirectory).startsWith('codebuddy-status-vite-')
  )
    await rm(cacheDirectory, { recursive: true, force: true });
});

for (const [locale, labels] of Object.entries({
  'zh-CN': [
    '等待模型服务返回',
    '正在思考',
    '正在撰写回复',
    '正在整理工具结果',
    '请确认：发送消息',
    '正在停止当前操作',
  ],
  'zh-TW': [
    '等待模型服務回應',
    '正在思考',
    '正在撰寫回覆',
    '正在整理工具結果',
    '請確認：发送消息',
    '正在停止目前操作',
  ],
  en: [
    'Waiting for the model service',
    'Thinking',
    'Writing a response',
    'Reviewing the tool results',
    'Please approve: 发送消息',
    'Stopping the current operation',
  ],
})) {
  test(`real browser shows meaningful ${locale} states without masking confirmation or errors`, async () => {
    const page = await browser.newPage();
    try {
      await page.goto(
        `${server.resolvedUrls!.local[0]}tests/browser-fixtures/work-status.html?locale=${locale}`
      );
      const status = page.getByRole('status');
      for (const [index, mode] of [
        'waiting',
        'thought',
        'text',
        'tool_result',
        'approval',
        'cancel',
      ].entries()) {
        await page.getByRole('button', { name: mode, exact: true }).click();
        await expect(status).toContainText(labels[index]);
      }
      await page.getByRole('button', { name: 'reconnect', exact: true }).click();
      await expect(status).toHaveText('连接发生错误；正在重新连接（1/5）');
      await page.getByRole('button', { name: 'waiting', exact: true }).click();
      await expect(status.locator('svg')).toBeVisible();
      await expect(status.locator('.activity-dots')).toHaveCount(0);
      await page.clock.install();
      await page.clock.fastForward(206000);
      await expect(page.getByTestId('wait-hint')).toBeVisible();
      await page.screenshot({ path: test.info().outputPath('work-status.png') });
    } finally {
      await page.close();
    }
  });
}
