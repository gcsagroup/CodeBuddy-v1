import { chromium, expect, test, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve, dirname, basename } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
let server: ViteDevServer;
let browser: Browser;
let cacheDirectory: string;
test.beforeAll(async () => {
  cacheDirectory = await mkdtemp(resolve(tmpdir(), 'codebuddy-custom-agents-vite-'));
  server = await createServer({ configFile: resolve('vite.renderer.config.mts'), cacheDir: cacheDirectory,
    optimizeDeps: { entries: ['tests/browser-fixtures/custom-agents.html'] },
    resolve: { alias: [{ find: /.*\/acp\/acpConnection$/, replacement: resolve('tests/browser-fixtures/custom-agents-api.ts') }] },
    server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen(); browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
});
test.afterAll(async () => {
  await browser?.close(); await server?.close();
  if (cacheDirectory && dirname(resolve(cacheDirectory)) === resolve(tmpdir()) && basename(cacheDirectory).startsWith('codebuddy-custom-agents-vite-')) await rm(cacheDirectory, { recursive: true, force: true });
});
test('create, edit, launch and delete a role; verify desktop and narrow layout', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/custom-agents.html');
    await page.getByRole('button', { name: '新建智能体' }).click();
    const avatars = page.getByRole('group', { name: '头像', exact: true });
    await expect(avatars.getByRole('button').first()).toHaveAccessibleName('头像 应用 Logo');
    await expect(avatars.getByRole('button').first()).toHaveAttribute('aria-pressed', 'true');
    await expect(avatars.getByRole('button').last()).toHaveAccessibleName('上传头像');
    await page.getByLabel('头像图片文件').setInputFiles(resolve('src/images/mark.png'));
    await expect(page.getByRole('button', { name: '头像 自定义图片' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByLabel('名称', { exact: true }).fill('研究伙伴');
    await page.getByLabel('模型', { exact: true }).selectOption(JSON.stringify(['fixture', 'research-model']));
    await page.getByLabel('人设提示词').fill('你是一位严谨而友善的研究伙伴。先核对证据，再清晰解释；对无法确认的信息明确说明。');

    await page.getByRole('checkbox', { name: /research/ }).check();
    await page.getByRole('checkbox', { name: /read/ }).check();
    await page.getByRole('checkbox', { name: /knowledge/ }).check();
    await expect(page.getByText('语音 · 暂未开放')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('custom-agents-editor.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('custom-agents-narrow.png') });
    await page.getByRole('button', { name: '保存智能体' }).click();
    await expect(page.getByRole('heading', { name: '研究伙伴' })).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.screenshot({ path: test.info().outputPath('custom-agents-list.png') });
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await expect(page.getByRole('button', { name: '头像 自定义图片' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('checkbox', { name: /research/ })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: /write/ })).not.toBeChecked();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '创建工作区' }).click();
    await expect(page.getByTestId('location')).toHaveText('/codepro/pair?resumeSessionId=fixture-workspace');
    await page.getByRole('button', { name: '删除 研究伙伴' }).click();
    await page.getByRole('button', { name: '确认删除' }).click();
    await expect(page.getByRole('heading', { name: '创建你的第一个智能体' })).toBeVisible();
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/custom-agents.html?dark');
    await page.getByRole('button', { name: '新建智能体' }).click();
    await expect(page.getByLabel('人设提示词')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('custom-agents-dark.png') });
    expect(errors).toEqual([]);
  } finally { await page.close(); }
});
