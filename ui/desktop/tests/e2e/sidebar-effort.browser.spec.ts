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
    const workspaceActions = page.getByRole('button', { name: '工作区选项' });
    const taskActions = page.getByRole('button', { name: '任务选项' });
    await expect(workspaceActions).toHaveCSS('opacity', '0');
    await expect(taskActions).toHaveCSS('opacity', '0');
    await workspaces.hover();
    await expect(workspaceActions).toHaveCSS('opacity', '1');
    await expect(taskActions).toHaveCSS('opacity', '0');
    await tasks.hover();
    await expect(workspaceActions).toHaveCSS('opacity', '0');
    await expect(taskActions).toHaveCSS('opacity', '1');
    await workspaces.hover();
    await page.getByRole('button', { name: '工作区选项' }).click();
    await page.getByRole('menuitem', { name: '收起分组' }).click();
    await expect(page.getByRole('button', { name: '工作区', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await workspaces.hover();
    await page.getByRole('button', { name: '选择工作区并新建对话' }).click();
    await expect(page.getByTestId('route')).toContainText('"workingDir":"D:/Chosen"');
    await page.getByRole('button', { name: '工作区', exact: true }).click();
    await tasks.hover();
    await page.getByRole('button', { name: '任务选项' }).click();
    await expect(page.getByRole('menuitem', { name: '历史记录' })).toBeVisible();
    await page.keyboard.press('Escape');
    await tasks.hover();
    await page.getByRole('button', { name: '新建任务对话' }).click();
    await expect(page.getByTestId('route')).toContainText('"workingDir":""');
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

test('empty workspaces disappear and the selected main chat uses the same full-row gray as tasks', async () => {
  const page = await browser.newPage();
  try {
    await page.exposeFunction('fixtureRequest', () => ({}));
    const query = new URLSearchParams({ emptyWorkspace: '1', entry: '/pair?resumeSessionId=main' });
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/sidebar-effort.html?' + query);
    const main = page.getByRole('button', { name: '主对话', exact: true });
    const task = page.getByRole('button', { name: '旧任务', exact: true });
    await expect(main).toHaveAttribute('aria-current', 'page');
    await expect(task).toBeVisible();
    await expect(page.getByRole('button', { name: '工作区', exact: true })).toHaveCount(0);
    await task.hover();
    const gray = 'rgb(227, 230, 234)';
    await expect(task.locator('..')).toHaveCSS('background-color', gray);
    const row = main.locator('..');
    await expect(row).toHaveCSS('background-color', gray);
    await expect(main).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await row.hover();
    await expect(row.getByRole('button', { name: '清空主对话历史' })).toHaveCSS('opacity', '1');
    await page.locator('.shell-navigation').screenshot({ path: test.info().outputPath('main-chat-sidebar.png') });
    await task.click();
    await expect(task).toHaveAttribute('aria-current', 'page');
    await main.focus();
    await page.mouse.move(800, 400);
    await expect(task.locator('..')).toHaveCSS('background-color', gray);
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
    await expect(card).toBeVisible();
    const bounds = (await card.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(600);
    expect(await scroller.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  } finally { await page.close(); }
});

test('sidebar row boundaries stay fixed as the pointer moves between project chats', async () => {
  const page = await browser.newPage();
  await page.exposeFunction('fixtureRequest', () => ({}));
  try {
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/sidebar-effort.html');
    const first = page.getByRole('button', { name: '项目甲的新对话', exact: true }).locator('..');
    const second = page.getByRole('button', { name: '项目甲的旧对话', exact: true }).locator('..');
    await expect(second).toBeVisible();
    const initial = (await first.boundingBox())!;
    const next = (await second.boundingBox())!;
    const x = initial.x + 30;
    await page.mouse.move(x, initial.y + initial.height - 1);
    expect((await first.boundingBox())!.height).toBe(initial.height);
    expect((await second.boundingBox())!.y).toBe(next.y);
    for (let i = 0; i < 3; i++) {
      await page.mouse.move(x, next.y + 1);
      await page.mouse.move(x, initial.y + initial.height - 1);
    }
    expect(await page.getByRole('tooltip').count()).toBe(0);
    await expect(page.getByRole('tooltip')).toContainText('项目甲的新对话');
    await page.mouse.move(x, next.y + 1);
    await expect(page.getByRole('tooltip')).toContainText('项目甲的旧对话');
    await page.mouse.move(900, 500);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
  } finally { await page.close(); }
});

test('leaving a sidebar row dismisses its card even when the pointer crosses the card', async () => {
  const page = await browser.newPage();
  await page.exposeFunction('fixtureRequest', () => ({}));
  try {
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/sidebar-effort.html');
    for (const name of ['项目甲的新对话', '旧任务', 'Alpha']) {
      const button = page.getByRole('button', { name, exact: true });
      await button.hover();
      const card = page.locator('[data-slot="tooltip-content"]');
      await expect(card).toBeVisible();
      const rect = (await card.boundingBox())!;
      await page.mouse.move(rect.x + 20, rect.y + 12, { steps: 8 });
      await expect(card).toHaveCount(0, { timeout: 1500 });
      await button.hover();
      await expect(card).toBeVisible();
      await page.mouse.move(900, 500);
      await expect(card).toHaveCount(0);
    }
    const project = page.getByRole('button', { name: 'Alpha', exact: true });
    await project.focus();
    await expect(page.getByRole('tooltip')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tooltip')).toHaveCount(0);
  } finally { await page.close(); }
});

test('reopening history preserves running indicators independently for two sidebar rows', async () => {
  const page = await browser.newPage();
  await page.exposeFunction('fixtureRequest', () => ({}));
  try {
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/sidebar-effort.html');
    const status = (sessionId: string, streamState: string) => page.evaluate(detail => {
      window.dispatchEvent(new CustomEvent('session-status-update', { detail }));
    }, { sessionId, streamState });
    const row = (name: string) => page.getByRole('button', { name, exact: true }).locator('..');
    const project = row('项目甲的新对话'), task = row('旧任务');
    const spinner = (target: typeof task) => target.getByRole('img', { name: '流式传输中' });
    await expect(project).toBeVisible();
    await status('t-old', 'loading');
    await expect(spinner(task)).toHaveCount(0);
    await status('a-new', 'streaming');
    await status('t-old', 'streaming');
    await status('a-new', 'loading');
    await expect(spinner(project)).toBeVisible();
    await expect(spinner(task)).toBeVisible();
    await status('a-new', 'idle');
    await expect(spinner(project)).toHaveCount(0);
    await expect(spinner(task)).toBeVisible();
    await status('t-old', 'idle');
    await expect(spinner(task)).toHaveCount(0);
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

for (const dark of [false, true]) test(`workspace card, long and short folder names (${dark ? 'dark' : 'light'})`, async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 790 } });
  await page.exposeFunction('fixtureRequest', () => ({}));
  try {
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/sidebar-effort.html?longFolders=1' + (dark ? '&dark=1' : ''));
    const name = '桌面产品跨平台体验设计与集成验收记录归档目录';
    const folder = page.getByRole('button', { name, exact: true });
    await folder.hover();
    const text = folder.locator('.conversation-title-text');
    await expect(text).toHaveCSS('animation-name', 'conversation-title-reveal');
    await expect(text).toHaveCSS('animation-delay', '0s');
    const card = page.getByRole('tooltip');
    await expect(card).toContainText('D:/工作区/' + name);
    await expect(card).toContainText('2 个最近对话 · 0 个运行中');
    const popup = page.locator('[data-slot="tooltip-content"]');
    const box = (await popup.boundingBox())!;
    const action = (await folder.locator('..').getByRole('button', { name: '在项目中新建对话' }).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(action.x + action.width);
    await page.screenshot({ path: test.info().outputPath('workspace-card.png'), animations: 'disabled',
      clip: { x: 0, y: Math.floor(box.y - 30), width: Math.ceil(box.x + box.width + 12), height: Math.ceil(box.height + 64) } });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(text).toHaveCSS('animation-name', 'none');
    const short = page.getByRole('button', { name: 'Beta', exact: true });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await short.hover();
    await expect(short.locator('.conversation-title-text')).toHaveCSS('animation-name', 'none');
    await short.click();
    await expect(short).toHaveAttribute('aria-expanded', 'false');
  } finally { await page.close(); }
});

test('sidebar accepts drops in task whitespace and project padding, with destination highlighting', async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1200 } });
  const requests: {method: string; input: any}[] = [];
  await page.exposeFunction('fixtureRequest', (method: string, input: any) => { requests.push({method, input}); return {}; });
  try {
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/sidebar-effort.html?tall=1');
    const tasks = page.locator('[data-task-drop]');
    const source = page.locator('[data-session-row]').filter({hasText:'项目甲的新对话'});
    await source.waitFor();
    const box = (await tasks.boundingBox())!;
    const last = (await page.locator('[data-session-row]').filter({hasText:'旧任务'}).boundingBox())!;
    expect(box.y + box.height - (last.y + last.height)).toBeGreaterThan(60);
    const start = (await source.boundingBox())!;
    await page.mouse.move(start.x + 5, start.y + 12); await page.mouse.down();
    await page.mouse.move(start.x + 15, start.y + 18, {steps: 5});
    await page.mouse.move(box.x + 40, box.y + box.height - 30, {steps: 10});
    await page.mouse.move(box.x + 41, box.y + box.height - 29);
    await expect(tasks).toHaveAttribute('data-drop-active', 'true');
    await page.mouse.up();
    await expect.poll(() => requests.filter(r => r.method === 'navigation-move').map(r => r.input)).toContainEqual({sessionId:'a-new',destination:'tasks'});
    await expect(tasks).not.toHaveAttribute('data-drop-active', 'true');
    const project = page.locator('[data-project-drop="D:/Alpha"]');
    const projectBox = (await project.boundingBox())!;
    await page.locator('[data-session-row]').filter({hasText:'旧任务'}).dragTo(project, {sourcePosition:{x:5,y:12},targetPosition:{x:15,y:projectBox.height-5}});
    await expect.poll(() => requests.filter(r => r.method === 'navigation-move').map(r => r.input)).toContainEqual({sessionId:'t-old',destination:'project',workingDir:'D:/Alpha'});
    await project.locator('[data-workspace-row]').click({button:'right'});
    await expect(page.getByRole('menuitem',{name:'移除项目',exact:true}).locator('.lucide-folder-minus')).toBeVisible();
  } finally { await page.close(); }
});
