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
    await expect(avatars.getByRole('button', { name: '头像 🦉', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: /更多头像/ }).click();
    await avatars.getByRole('button', { name: '头像 🦉', exact: true }).click();
    await page.getByRole('button', { name: '收起头像' }).click();
    await expect(avatars.getByRole('button', { name: '头像 🦉', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(avatars.getByRole('button', { name: '头像 🐼', exact: true })).toHaveCount(0);
    await expect(avatars.getByRole('button').last()).toHaveText('上传图片');
    await page.getByLabel('头像图片文件').setInputFiles(resolve('src/images/mark.png'));
    await expect(page.getByRole('button', { name: '头像 自定义图片' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByLabel('名称', { exact: true }).fill('研究伙伴');
    await expect(page.getByLabel('模型', { exact: true })).toHaveCount(0);
    await page.getByLabel('人设提示词').fill('你是一位严谨而友善的研究伙伴。先核对证据，再清晰解释；对无法确认的信息明确说明。');
    await expect(page.getByLabel('能力配置')).toHaveCount(0);
    await expect(page.getByText('语音 · 暂未开放')).toHaveCount(0);
    await page.getByRole('checkbox', { name: '界面设计', exact: true }).check();
    await page.screenshot({ path: test.info().outputPath('custom-agents-editor.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('custom-agents-narrow.png') });
    await page.getByRole('button', { name: '仅保存', exact: true }).click();
    await expect(page.getByRole('heading', { name: '研究伙伴' })).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.screenshot({ path: test.info().outputPath('custom-agents-list.png') });
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await expect(page.getByRole('button', { name: '头像 自定义图片' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('checkbox', { name: '界面设计', exact: true })).toBeChecked();
    await expect(page.getByRole('group', { name: /可用工具/ })).toHaveCount(0);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '立即使用 研究伙伴', exact: true }).click();
    await expect(page.getByTestId('location')).toHaveText('/');
    await page.getByRole('button', { name: '删除 研究伙伴' }).click();
    await page.getByRole('button', { name: '确认删除' }).click();
    await expect(page.getByRole('heading', { name: '研究伙伴' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '默认模板' })).toBeVisible();
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/custom-agents.html?dark');
    await page.getByRole('button', { name: '新建智能体' }).click();
    await expect(page.getByLabel('人设提示词')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('custom-agents-dark.png') });
    expect(errors).toEqual([]);
  } finally { await page.close(); }
});

test('default templates include real skill bindings and remain usable at desktop and narrow widths', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/custom-agents.html');
    await expect(page.getByRole('button', { name: /^立即使用 / })).toHaveCount(6);
    await page.screenshot({ path: test.info().outputPath('agent-presets-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('agent-presets-narrow.png') });
    await page.getByRole('button', { name: '自定义 高级开发工程师', exact: true }).click();
    await expect(page.getByLabel('名称', { exact: true })).toHaveValue('高级开发工程师');
    await expect(page.getByLabel('模型', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: /排查与修复/ })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: /代码审查/ })).toBeChecked();
    await page.getByLabel('名称', { exact: true }).fill('我的开发助手');
    await page.getByRole('button', { name: '仅保存', exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 1560 });
    const builtinCard = page.getByRole('article').filter({ has: page.getByRole('heading', { name: '高级开发工程师', exact: true }) });
    const customCard = page.getByRole('article').filter({ has: page.getByRole('heading', { name: '我的开发助手', exact: true }) });
    const dimensions = await Promise.all([builtinCard.boundingBox(), customCard.boundingBox()]);
    expect(dimensions[0]!.height).toBe(dimensions[1]!.height);
    expect(dimensions[0]!.width).toBe(dimensions[1]!.width);
    await page.screenshot({ path: test.info().outputPath('unified-agent-cards.png'), fullPage: true });
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/custom-agents.html?dark');
    await page.setViewportSize({ width: 1280, height: 1000 });
    await expect(page.getByRole('button', { name: /^立即使用 / })).toHaveCount(6);
    await page.screenshot({ path: test.info().outputPath('agent-presets-dark.png'), fullPage: true });
    expect(errors).toEqual([]);
  } finally { await page.close(); }
});
