import { chromium, expect, test, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve, dirname, basename } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

let browser: Browser, server: ViteDevServer, directory: string;
test.beforeAll(async () => {
  directory = await mkdtemp(resolve(tmpdir(), 'codebuddy-sidebar-effort-'));
  server = await createServer({ configFile: resolve('vite.renderer.config.mts'), cacheDir: directory,
    optimizeDeps: { entries: ['tests/browser-fixtures/sidebar-effort.html'] },
    resolve: { alias: [{ find: /.*\/acpConnection$/, replacement: resolve('tests/browser-fixtures/sidebar-effort-api.ts') }] },
    server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen(); browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
});
test.afterAll(async () => {
  await browser?.close(); await server?.close();
  if (directory && dirname(directory) === tmpdir() && basename(directory).startsWith('codebuddy-sidebar-effort-'))
    await rm(directory, { recursive: true, force: true });
});
test('scoped pins, folder actions and deferred thinking changes work with real browser input', async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const requests: { method: string; input: any }[] = [];
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('fixtureRequest', (method: string, input: any) => { requests.push({ method, input }); return {}; });
  try {
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/sidebar-effort.html');
    const workspaces = page.getByText('工作区', { exact: true });
    const tasks = page.getByText('任务', { exact: true });
    await expect(workspaces).toBeVisible();
    expect((await workspaces.boundingBox())!.y).toBeLessThan((await tasks.boundingBox())!.y);
    const row = (title: string) => page.locator('span[title]').filter({ hasText: title }).locator('..');
    await row('项目甲的旧对话').hover();
    await row('项目甲的旧对话').getByRole('button', { name: '置顶会话', exact: true }).click();
    await expect(row('项目甲的旧对话').getByRole('button', { name: '取消置顶', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await row('项目甲的旧对话').boundingBox())!.y - (await row('项目甲的新对话').boundingBox())!.y).toBeLessThan(0);
    await expect(page.getByText('置顶', { exact: true })).toHaveCount(0);
    await row('旧任务').hover(); await row('旧任务').getByRole('button', { name: '置顶会话', exact: true }).click();
    await expect.poll(async () => (await row('旧任务').boundingBox())!.y - (await row('新任务').boundingBox())!.y).toBeLessThan(0);
    const beta = page.getByRole('button', { name: 'Beta', exact: true }).locator('..');
    await beta.hover(); await beta.getByRole('button', { name: '项目操作' }).click();
    await page.getByRole('menuitem', { name: '打开文件夹', exact: true }).click();
    await expect.poll(() => requests.filter(r => r.method === 'open-folder')).toEqual([{ method: 'open-folder', input: { path: 'D:/Beta' } }]);
    await beta.hover(); await beta.getByRole('button', { name: '项目操作' }).click();
    await page.getByRole('menuitem', { name: '置顶项目', exact: true }).click();
    await expect.poll(async () => (await beta.boundingBox())!.y - (await page.getByRole('button', { name: 'Alpha', exact: true }).boundingBox())!.y).toBeLessThan(0);
    await beta.hover(); await beta.getByRole('button', { name: '在项目中新建对话' }).click();
    await expect(page.getByTestId('route')).toContainText('D:/Beta');
    await beta.hover(); await beta.getByRole('button', { name: '项目操作' }).click();
    await page.getByRole('menuitem', { name: '归档项目中的对话' }).click();
    await expect(page.getByRole('dialog')).toContainText('1 个对话');
    expect(requests.filter(r => r.method === 'archive')).toHaveLength(0);
    await page.getByRole('dialog').getByRole('button', { name: '归档会话' }).click();
    await expect(page.getByText('项目乙对话', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: /思考强度/ }).click();
    const slider = page.getByRole('slider'); await slider.focus();
    for (const key of ['Home', 'ArrowRight', 'End', 'Home']) await page.keyboard.press(key);
    expect(requests.filter(r => r.method === 'config-save')).toHaveLength(0);
    await page.keyboard.press('Escape'); await page.getByRole('button', { name: '发送测试任务' }).click();
    await expect.poll(() => requests.filter(r => r.method === 'config-save').length).toBe(1);
    expect(requests.at(-1)!.input.fields).toEqual([{ key: 'thinkingEffort:model', value: 'low' }]);
    await page.screenshot({ path: test.info().outputPath('sidebar-effort.png') });
    expect(errors).toEqual([]);
  } finally { await page.close(); }
});


test('legacy entry and old configuration keep the unified navigation', async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  await page.exposeFunction('fixtureRequest', () => ({}));
  try {
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/sidebar-effort.html?entry=' + encodeURIComponent('/pair?resumeSessionId=old-task'));
    await expect(page.getByTestId('route')).toContainText('/codepro/pair');
    await expect(page.getByRole('group', { name: /Workspace switcher|工作区切换/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Code', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'CodePro', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'CodeBuddy', exact: true }).click();
    await expect(page.getByTestId('route')).toContainText('"path":"/codepro"');
    await page.getByRole('button', { name: '历史记录', exact: true }).click();
    await expect(page.getByTestId('route')).toContainText('/codepro/sessions');
    await page.screenshot({ path: test.info().outputPath('unified-navigation.png') });
  } finally { await page.close(); }
});
