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
    const row = (title: string) => page.locator('[data-session-row]').filter({ has: page.getByRole('button', { name: title, exact: true }) });
    await row('项目甲的旧对话').hover();
    await row('项目甲的旧对话').getByRole('button', { name: '置顶会话', exact: true }).click();
    // Pinning moves the row away from the pointer; reveal its actions at the new position.
    await row('项目甲的旧对话').hover();
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

test('long sidebar names move immediately and expose a complete metadata card', async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  await page.exposeFunction('fixtureRequest', () => ({}));
  const title = '修复七项体验问题并验收 Windows 和 Mac 安装包，保留完整历史与验证证据 (12)';
  try {
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/sidebar-effort.html?longTitles=1');
    const button = page.getByRole('button', { name: title, exact: true });
    const row = button.locator('..');
    await expect(button).toBeVisible();
    const initialWidth = (await button.boundingBox())!.width;
    const scroller = page.locator('.shell-navigation .sidebar-scrollbar');
    const gap = await row.evaluate((el) => { const scroll = el.closest('.sidebar-scrollbar')!; return scroll.getBoundingClientRect().left + scroll.clientWidth - el.getBoundingClientRect().right; });
    expect(gap).toBeLessThanOrEqual(4);
    await button.hover();
    await page.waitForTimeout(120);
    const text = button.locator('.conversation-title-text');
    expect(await text.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).m41)).toBeLessThan(-0.1);
    expect(await text.evaluate(el => getComputedStyle(el).animationDelay)).toBe('0s');
    await expect(page.getByRole('tooltip')).toContainText(title);
    await expect(page.getByRole('tooltip')).toContainText('D:/Alpha');
    await expect(page.getByRole('tooltip')).toContainText('2026');
    await expect(page.getByRole('tooltip')).toContainText('最近更新');
    expect((await button.boundingBox())!.width).toBeLessThan(initialWidth);
    await expect(row.getByRole('button', { name: '置顶会话', exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('sidebar-hover-card.png') });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await page.mouse.move(700, 100);
    await expect(text).toHaveCSS('transform', 'none');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await button.hover();
    await expect(text).toHaveCSS('animation-name', 'none');
    await page.setViewportSize({ width: 600, height: 650 });
    const card = page.locator('[data-slot="tooltip-content"]').first();
    const bounds = (await card.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(600);
    expect(await scroller.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
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
