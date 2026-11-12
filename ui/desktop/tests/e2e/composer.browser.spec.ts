import { chromium, expect, test, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve, dirname, basename } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { fixtureModel, fixtureProvider } from '../browser-fixtures/composer-model-context';

let server: ViteDevServer;
let browser: Browser;
let cacheDirectory: string;
test('delegated briefs arrive automatically for their own project turn', async () => {
  const page = await browser.newPage();
  const requests: unknown[] = [];
  try {
    await page.exposeFunction('fixtureProjectBrief', (args: { detailSessionId: string }) => {
      requests.push(args);
      const plane = args.detailSessionId === 'child-1';
      return { title: plane ? '飞机大战' : '网盘', task: '开发', result: plane ? '键盘操作已接入' : '支持上传文件', files: [], fileCount: 0 };
    });
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/composer.html?brief');
    const plane = page.getByRole('article', { name: '项目简报 · 飞机大战' });
    const disk = page.getByRole('article', { name: '项目简报 · 网盘' });
    await expect(plane.getByText('键盘操作已接入')).toBeVisible();
    await expect(disk.getByText('支持上传文件')).toBeVisible();
    await expect(plane.getByText(/game\.js/)).toBeVisible();
    expect(requests).toEqual([{ sessionId: 'main', detailSessionId: 'child-0', requestId: 'request-0' }]);
  } finally { await page.close(); }
});
test('a draft workspace can be cleared without losing typed text', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/composer.html?hub');
    const input = page.getByTestId('chat-input');
    await expect(page.getByRole('heading', { name: '我是 CodeBuddy，一起把事情做好。' })).toBeVisible();
    await expect(page.getByText('写代码与排错')).toBeVisible();
    await expect(page.getByTestId('composer-stats')).toHaveCount(0);
    await input.fill('保留这条草稿');
    const chip = page.getByRole('button', { name: 'D:/Chosen' });
    const clear = page.getByRole('button', { name: '取消选择工作区' });
    await expect(clear).toHaveCSS('opacity', '0');
    await page.screenshot({ path: test.info().outputPath('new-chat.png') });
    await chip.hover();
    await expect(clear).toHaveCSS('opacity', '1');
    await chip.locator('..').screenshot({ path: test.info().outputPath('workspace-hover.png') });
    await chip.click();
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByRole('menu').getByText(/工作树/)).toHaveCount(0);
    await page.getByRole('menu').screenshot({ path: test.info().outputPath('workspace-menu.png') });
    await page.keyboard.press('Escape');
    await page.mouse.move(0, 0);
    await chip.focus();
    await page.keyboard.press('Tab');
    await expect(clear).toBeFocused();
    await expect(clear).toHaveCSS('opacity', '1');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: '选择工作区', exact: true })).toBeFocused();
    await expect(input).toHaveValue('保留这条草稿');
    await expect(page.getByRole('button', { name: '取消选择工作区' })).toHaveCount(0);
    await page.getByRole('button', { name: '选择工作区', exact: true }).click();
    await page.getByRole('menuitem', { name: /Another/ }).click();
    await page.getByRole('button', { name: 'D:/Another' }).hover();
    await clear.click();
    await expect(chip).toHaveCount(0);
    await expect(page.getByRole('button', { name: '选择工作区', exact: true })).toBeFocused();
    await expect(input).toHaveValue('保留这条草稿');
  } finally { await page.close(); }
});
const composerCacheRoot = resolve('../../.local');

test('continue and send share the same composer position after stopping', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/composer.html?stopped');
    const resume = page.getByRole('button', { name: '继续任务', exact: true });
    const send = page.getByRole('button', { name: '发送', exact: true });
    const input = page.getByTestId('chat-input');
    await expect(resume).toBeVisible();
    const position = await resume.boundingBox();
    await expect(send).toHaveCount(0);
    await input.fill('新问题');
    await expect(send).toBeEnabled();
    expect(await send.boundingBox()).toEqual(position);
    await expect(resume).toHaveCount(0);
    await input.fill('');
    await resume.click();
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
    await expect(resume).toHaveCount(0);
  } finally { await page.close(); }
});

test('composer statistics stay readable, explain their scope and preserve send in narrow layouts', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/composer.html?stats=1');
    const stats = page.getByTestId('composer-stats');
    await expect(stats.getByText('220 tok/s')).toBeVisible();
    const card = page.locator('.shell-composer-card');
    expect(await stats.evaluate(el => el.closest('.shell-composer-card') === null)).toBe(true);
    expect((await stats.boundingBox())!.y).toBeGreaterThanOrEqual((await card.boundingBox())!.y + (await card.boundingBox())!.height - 1);
    const toggle = page.getByRole('button', { name: '切换运行状态' });
    await toggle.click();
    await expect(stats.getByRole('button', { name: '上次采样的生成速度' })).toHaveText('≈35.0 tok/s');
    await page.getByRole('button', { name: '切换速度采样' }).click();
    await expect(stats.getByRole('button', { name: '当前生成速度' })).toHaveText('42.0 tok/s');
    await toggle.click();
    await expect(stats.getByText('220 tok/s')).toBeVisible();
    await expect(stats.getByText('缓存命中 82%')).toBeVisible();
    await expect(stats.getByText('上下文 6%')).toBeVisible();
    await stats.getByRole('button', { name: '平均生成速度', exact: true }).focus();
    await expect(page.getByRole('tooltip')).toContainText('不含首字等待和工具执行时间');
    await page.keyboard.press('Escape');
    await stats.getByRole('button', { name: '缓存命中', exact: true }).hover();
    await expect(page.getByRole('tooltip')).toContainText('缓存读取 820 / 总输入 1,000');
    await page.mouse.move(0, 0);
    await page.keyboard.press('Escape');
    await page.getByTestId('chat-input').click();
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await page.getByTestId('composer-container').screenshot({ path: test.info().outputPath('composer-stats-wide.png') });
    await page.getByRole('spinbutton', { name: '左侧宽度' }).fill('0');
    await page.getByRole('spinbutton', { name: '右侧宽度' }).fill('0');
    await page.setViewportSize({ width: 420, height: 800 });
    const input = page.getByTestId('chat-input');
    await input.fill('检查新的输入框');
    const send = page.getByRole('button', { name: '发送', exact: true });
    await expect(send).toBeVisible();
    expect(await stats.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    const controls = await stats.locator('button').evaluateAll(buttons => buttons.map(b => {
      const r = b.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    }));
    expect(controls.every(b => b.left >= 0 && b.right <= 420)).toBe(true);
    expect(controls.every((a, i) => controls.slice(i + 1).every(b => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top))).toBe(true);
    await page.screenshot({ path: test.info().outputPath('composer-stats-narrow.png') });
    await send.click();
    await expect(page.getByRole('status')).toHaveText('检查新的输入框');
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/composer.html?dark=1');
    await expect(page.getByTestId('composer-stats').getByText('— tok/s')).toBeVisible();
    await expect(page.getByTestId('composer-stats').getByText('缓存命中 未上报')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('composer-stats-dark-empty.png') });
  } finally { await page.close(); }
});
test.beforeAll(async () => {
  await mkdir(composerCacheRoot, { recursive: true });
  cacheDirectory = await mkdtemp(resolve(composerCacheRoot, 'codebuddy-composer-vite-'));
  server = await createServer({
    configFile: resolve('vite.renderer.config.mts'),
    cacheDir: cacheDirectory,
    optimizeDeps: { entries: ['tests/browser-fixtures/composer.html'] },
    resolve: {
      alias: [
        {
          find: /.*\/acpConnection$/,
          replacement: resolve('tests/browser-fixtures/composer-api.ts'),
        },
        {
          find: /.*\/ModelAndProviderContext$/,
          replacement: resolve('tests/browser-fixtures/composer-model-context.ts'),
        },
      ],
    },
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
    dirname(resolve(cacheDirectory)) === composerCacheRoot &&
    basename(cacheDirectory).startsWith('codebuddy-composer-vite-')
  )
    await rm(cacheDirectory, { recursive: true, force: true });
});

test('model refresh discovers new remote models and preserves the last list on service failure', async () => {
  const { discover, inventory } = await import('../../../../runtime/providers.mjs');
  let fail = false;
  const endpoint = createHttpServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.statusCode = fail ? 503 : 200;
    response.end(JSON.stringify(fail ? { error: 'fixture unavailable' } : { data: [{ id: fixtureModel }, { id: 'new-remote-model' }] }));
  });
  await new Promise<void>(done => endpoint.listen(0, '127.0.0.1', done));
  const provider = { id: fixtureProvider, displayName: 'Fixture connection', engine: 'openai_compatible',
    apiUrl: `http://127.0.0.1:${(endpoint.address() as { port: number }).port}`, requiresAuth: false,
    models: [fixtureModel] };
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  try {
    await page.exposeFunction('fixtureModelInventory', () => ({ entries: [inventory(provider)] }));
    await page.exposeFunction('fixtureRefreshModels', async ({ providerIds }: { providerIds: string[] }) => {
      expect(providerIds).toEqual([fixtureProvider]);
      provider.models = await discover(provider, provider);
      return { started: providerIds, skipped: [] };
    });
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/composer.html');
    await page.getByRole('button', { name: /思考强度/ }).click();
    await page.getByRole('button', { name: fixtureModel, exact: true }).click();
    const picker = page.locator('[data-model-picker-list]');
    await expect(picker.getByRole('button', { name: 'new-remote-model', exact: true })).toHaveCount(0);
    await picker.getByRole('button', { name: '刷新模型', exact: true }).click();
    await expect(picker.getByRole('status')).toHaveText('模型列表已更新。');
    await expect(picker.getByRole('button', { name: 'new-remote-model', exact: true })).toBeVisible();
    await expect(picker.getByRole('button', { name: fixtureModel, exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(provider.models).toContain('new-remote-model');
    fail = true;
    await picker.getByRole('button', { name: '刷新模型', exact: true }).click();
    await expect(picker.getByRole('alert')).toContainText('部分连接刷新失败');
    await expect(picker.getByRole('button', { name: 'new-remote-model', exact: true })).toBeVisible();
    await expect(picker.getByRole('button', { name: '刷新模型', exact: true })).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath('model-refresh.png'), fullPage: true });
  } finally {
    await page.close();
    endpoint.closeAllConnections();
    await new Promise<void>(done => endpoint.close(() => done()));
  }
});

test('large pasted text stays responsive before sending and after rendering the sent message', async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  try {
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/composer.html');
    const input = page.getByTestId('chat-input');
    await expect(input).toBeVisible();
    const payload = JSON.stringify({ messages: Array.from({ length: 1000 }, (_, i) => ({ id: i, text: '中文 🙂 [Pasted Content] ' + 'quoted nested text '.repeat(20) })) }, null, 2);
    const pasteMs = await input.evaluate(async (element, text) => {
      const start = performance.now();
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', text);
      // Include rich clipboard data to check that the large paste bypasses HTML parsing.
      clipboardData.setData('text/html', '<pre>' + text + '</pre>');
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      return performance.now() - start;
    }, payload);
    await expect(input).toHaveValue('');
    await expect(page.getByRole('button', { name: '移除粘贴文本' })).toBeVisible();
    await input.pressSequentially(' follow-up', { delay: 15 });
    await expect(input).toHaveValue(' follow-up');
    const sentStart = Date.now();
    await input.press('Enter');
    await expect(page.getByTestId('submitted-message').locator('[data-pasted-text]')).toBeVisible();
    const sendMs = Date.now() - sentStart;
    expect(await page.evaluate(() => (window as unknown as { composerSubmitted: string }).composerSubmitted)).toBe(payload + ' follow-up');
    expect((await page.getByTestId('submitted-message').textContent())!.length).toBeLessThan(1000);
    await input.pressSequentially('typing after send', { delay: 15 });
    await expect(input).toHaveValue('typing after send');
    const textBlock = page.getByTestId('submitted-message').getByRole('button', { name: '以 TXT 打开粘贴文本' });
    await textBlock.hover();
    const preview = page.getByRole('tooltip').locator('[data-pasted-text-hover]');
    await expect(preview).toBeVisible();
    expect((await preview.textContent())!.length).toBeLessThanOrEqual(12000);
    await textBlock.click();
    expect(await page.evaluate(() => (window as unknown as { openedPastedText: string }).openedPastedText)).toBe(payload + ' follow-up');
    console.log(JSON.stringify({ payloadChars: payload.length, pasteMs, sendMs, sentDomChars: (await page.getByTestId('submitted-message').textContent())!.length }));
    expect(pasteMs).toBeLessThan(1000);
    expect(sendMs).toBeLessThan(2000);
    await page.screenshot({ path: test.info().outputPath('large-paste-and-sent-preview.png') });
  } finally { await page.close(); }
});

test('attachments grow above a full-width editor and hover previews never change its layout', async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  try {
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/composer.html');
    const input = page.getByTestId('chat-input');
    await expect(input).toBeVisible();
    const original = (await input.boundingBox())!;
    const toolbar = page.getByRole('button', { name: '添加附件或功能' });
    const originalToolbar = (await toolbar.boundingBox())!;
    await page.getByRole('button', { name: '混合附件' }).click();
    const payload = '中文🙂\n'.repeat(25000);
    await input.evaluate((element, text) => {
      const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text);
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
    }, payload);
    const tray = page.getByTestId('composer-attachments');
    await expect(tray.locator('[data-pasted-text]')).toBeVisible();
    for (const kind of ['image', 'video', 'file']) await expect(tray.locator(`[data-attachment-kind="${kind}"]`)).toBeVisible();
    const editor = (await input.boundingBox())!, trayBox = (await tray.boundingBox())!;
    expect(editor.width).toBeCloseTo(original.width, 0);
    expect(editor.x).toBeCloseTo(original.x, 0);
    expect(trayBox.y + trayBox.height).toBeLessThanOrEqual(editor.y + 1);
    expect((await toolbar.boundingBox())!.y).toBeCloseTo(originalToolbar.y, 0);
    const textBlock = tray.getByRole('button', { name: '以 TXT 打开粘贴文本' });
    await textBlock.hover();
    await expect(page.getByRole('tooltip')).toBeVisible();
    expect((await input.boundingBox())!.y).toBeCloseTo(editor.y, 0);
    await input.hover();
    await expect(page.getByRole('tooltip')).not.toBeVisible();
    await expect(tray.locator('textarea')).toHaveCount(0);
    for (const button of await tray.getByRole('button', { name: /移除/ }).all()) {
      const appearance = await button.evaluate(element => { const s = getComputedStyle(element); return { background: s.backgroundColor, color: s.color, opacity: s.opacity }; });
      expect(appearance.background).not.toBe('rgba(0, 0, 0, 0)');
      expect(appearance.color).not.toBe(appearance.background);
      expect(appearance.opacity).toBe('1');
    }
    for (const width of [800, 430]) {
      await page.getByRole('spinbutton', { name: '左侧宽度' }).fill('0');
      await page.getByRole('spinbutton', { name: '右侧宽度' }).fill('0');
      await page.setViewportSize({ width, height: 850 });
      const box = (await input.boundingBox())!, root = (await page.getByTestId('composer-container').boundingBox())!;
      expect(box.width).toBeGreaterThan(root.width - 40);
      const attachments = (await tray.boundingBox())!;
      expect(attachments.y + attachments.height).toBeLessThanOrEqual(box.y + 1);
    }
    await input.pressSequentially('附件下面正常打字');
    await expect(input).toHaveValue('附件下面正常打字');
    await page.getByTestId('composer-container').screenshot({ path: resolve('../../.local/attachment-tray-final.png') });
    await textBlock.hover();
    await expect(page.getByRole('tooltip')).toBeVisible();
    await page.screenshot({ path: resolve('../../.local/attachment-hover-final.png') });
  } finally { await page.close(); }
});

test('separate pastes keep addition order and can be removed independently', async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  try {
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/composer.html');
    const input = page.getByTestId('chat-input');
    const paste = async (text: string) => input.evaluate((element, value) => {
      const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', value);
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
    }, text);
    const first = 'first text '.repeat(600), second = 'second text '.repeat(600);
    await paste(first);
    await page.getByRole('button', { name: '混合附件' }).click();
    const tray = page.getByTestId('composer-attachments');
    await expect(tray.locator('[data-attachment-kind="file"]')).toBeVisible();
    await paste(second);
    await expect(tray.locator('[data-attachment-kind="text"]')).toHaveCount(2);
    expect(await tray.locator(':scope > [data-attachment-kind]').evaluateAll(elements => elements.map(element => element.getAttribute('data-attachment-kind')))).toEqual(['text', 'image', 'video', 'file', 'text']);
    const textBoxes = await tray.locator('[data-attachment-kind="text"]').evaluateAll(elements => elements.map(element => { const box = element.getBoundingClientRect(); return { x: box.x, bottom: box.bottom }; }));
    expect(textBoxes[1].x).toBeGreaterThan(textBoxes[0].x);
    expect(textBoxes[1].bottom).toBeCloseTo(textBoxes[0].bottom, 0);
    expect(await tray.evaluate(element => getComputedStyle(element).scrollbarWidth)).toBe('none');
    await tray.getByRole('button', { name: '移除粘贴文本' }).first().click();
    await expect(tray.locator('[data-attachment-kind="text"]')).toHaveCount(1);
    await input.fill(' trailing');
    await input.press('Enter');
    await expect.poll(() => page.evaluate(() => (window as unknown as { composerSubmitted: string }).composerSubmitted)).toContain(second + ' trailing');
    const sent = await page.evaluate(() => (window as unknown as { composerSubmitted: string }).composerSubmitted);
    expect(sent).not.toContain(first);
  } finally { await page.close(); }
});

for (const kind of ['add', 'commands']) test(`${kind} menu keeps first height and scrollbar space during late loading`, async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  try {
    await page.addInitScript(() => Object.assign(window, { delayCommandInventory: true }));
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/composer.html');
    const input = page.getByTestId('chat-input');
    if (kind === 'add') await page.getByRole('button', { name: '添加附件或功能' }).click();
    else await input.fill('/');
    const menu = page.locator(`[data-composer-menu="${kind}"]`);
    const file = menu.getByRole('option', { name: /^文件/ });
    await expect(file).toBeVisible();
    await expect.poll(() => menu.evaluate(element => Boolean((element as HTMLElement).style.height))).toBe(true);
    const before = (await menu.boundingBox())!;
    const beforeFile = (await file.boundingBox())!;
    const description = await file.locator('.text-right').boundingBox();
    if (kind === 'add') {
      expect(await page.evaluate(() => typeof (window as unknown as { releaseCommandInventory?: () => void }).releaseCommandInventory)).toBe('undefined');
      const list = menu.getByRole('listbox');
      expect(await list.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
      await list.hover();
      await page.mouse.wheel(0, 300);
    }
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseCommandInventory?: () => void }).releaseCommandInventory)).toBe('function');
    await page.evaluate(() => (window as unknown as { releaseCommandInventory: () => void }).releaseCommandInventory());
    await expect(menu.getByRole('option', { name: /late-skill-0\b/ })).toHaveCount(1);
    if (kind === 'add') {
      expect(await menu.getByRole('option').count()).toBeLessThanOrEqual(20);
      await expect(menu.getByRole('option', { name: /late-skill-39/ })).toHaveCount(0);
    } else await expect(menu.getByRole('option', { name: /late-skill-39/ })).toHaveCount(1);
    const after = (await menu.boundingBox())!;
    expect(after.height).toBeCloseTo(before.height, 0);
    expect(after.y).toBeCloseTo(before.y, 0);
    expect((await file.boundingBox())!.width).toBeCloseTo(beforeFile.width, 0);
    const afterDescription = (await file.locator('.text-right').boundingBox())!;
    expect(afterDescription.x + afterDescription.width).toBeCloseTo(description!.x + description!.width, 0);
    const list = menu.getByRole('listbox');
    expect(await list.evaluate(element => getComputedStyle(element).scrollbarGutter)).toBe('stable');
    expect(await list.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await list.hover();
    await page.mouse.wheel(0, 3000);
    await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    if (kind === 'add') {
      await expect.poll(() => menu.getByRole('option').count()).toBeGreaterThan(20);
      await page.mouse.wheel(0, 3000);
      await expect(menu.getByRole('option', { name: /late-skill-39/ })).toHaveCount(1);
    }
  } finally { await page.close(); }
});

for (const dark of [false, true]) test(`context card is compact, centered and above chat controls (${dark ? 'dark' : 'light'})`, async () => {
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
  try {
    await page.goto(server.resolvedUrls!.local[0] + `tests/browser-fixtures/composer.html${dark ? '?dark' : ''}`);
    const ring = page.getByRole('button', { name: /上下文用量.*64,000/ });
    await expect(ring).toBeVisible();
    await page.getByTestId('composer-container').evaluate((element) => {
      element.style.transform = 'translateZ(0)';
      element.style.overflow = 'hidden';
    });
    await ring.hover();
    await ring.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const compact = dialog.getByRole('button', { name: '立即压缩' });
    await expect(compact).toBeEnabled();
    const appearance = await dialog.evaluate((element) => {
      const action = element.querySelector('button')!;
      const style = getComputedStyle(action);
      const lines = Array.from(element.querySelectorAll('p'));
      const box = element.getBoundingClientRect();
      const obstacle = document.createElement('div');
      Object.assign(obstacle.style, { position: 'fixed', top: box.top + 'px', left: box.left + 'px', width: box.width + 'px', height: box.height + 'px', zIndex: '60' });
      document.body.append(obstacle);
      const above = element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
      obstacle.remove();
      return {
        width: box.width, lines: lines.length, above,
        bodyPortal: element.parentElement === document.body,
        consistent: lines.every((p) => {
          const own = getComputedStyle(p);
          return own.color === style.color && own.textAlign === 'center' && getComputedStyle(p.parentElement!).backgroundColor === style.backgroundColor;
        }),
      };
    });
    expect(appearance).toEqual({ width: 176, lines: 2, above: true, bodyPortal: true, consistent: true });
    await dialog.screenshot({ path: resolve(`../../.local/context-card-${dark ? 'dark' : 'light'}.png`) });
  } finally { await page.close(); }
});

test('actual composer retains context, permission and send under sidebar pressure', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/composer.html');
    const ring = page.getByRole('button', { name: /上下文用量.*64,000/ });
    await expect(ring).toBeVisible();
    const composer = page.getByTestId('composer-container');
    const layouts = [
      { viewport: 1920, left: 240, right: 340, labels: 'all' },
      { viewport: 1280, left: 240, right: 340, labels: 'all' },
      { viewport: 1080, left: 240, right: 340, labels: 'model-effort' },
      { viewport: 960, left: 240, right: 340, labels: 'model' },
      { viewport: 960, left: 320, right: 320, labels: 'icons' },
      { viewport: 800, left: 220, right: 0, labels: 'all' },
      { viewport: 640, left: 240, right: 0, labels: 'model' },
      { viewport: 340, left: 0, right: 0, labels: 'icons' },
    ];
    for (const { viewport, left, right, labels } of layouts) {
      await page.setViewportSize({ width: viewport, height: 720 });
      await page.getByLabel('左侧宽度').fill(String(left));
      await page.getByLabel('右侧宽度').fill(String(right));
      await expect(ring).toBeVisible();
      const permission = page.getByRole('button', { name: '如何批准操作？' });
      await expect(permission).toHaveText('工作区内修改');
      const permissionLabel = permission.getByText('工作区内修改', { exact: true });
      if (labels === 'all') await expect(permissionLabel).toBeVisible();
      else await expect(permissionLabel).toBeHidden();
      const model = page.getByRole('button', { name: /思考强度/ });
      await expect(model).toBeVisible();
      const modelName = model.getByText(/deepseek-v4\.1-flash/);
      if (labels === 'icons') await expect(modelName).toBeHidden();
      else {
        await expect(modelName).toBeVisible();
        expect((await modelName.boundingBox())!.width).toBeGreaterThan(32);
      }
      const effortLabel = model.getByText('高', { exact: true }).first();
      if (labels === 'all' || labels === 'model-effort') await expect(effortLabel).toBeVisible();
      else await expect(effortLabel).toBeHidden();
      await expect
        .poll(async () => {
          const area = (await composer.boundingBox())!;
          const buttons = await composer.locator('[data-compact]').getByRole('button').all();
          const boxes = [];
          for (const button of buttons) {
            if (!(await button.isVisible())) continue;
            const box = (await button.boundingBox())!;
            if (box.x < area.x - 1 || box.x + box.width > area.x + area.width + 1) return false;
            boxes.push(box);
          }
          const rowCenter = boxes[0].y + boxes[0].height / 2;
          return boxes.every((box) => Math.abs(box.y + box.height / 2 - rowCenter) < 2) && boxes.every((a, i) =>
            boxes
              .slice(i + 1)
              .every(
                (b) =>
                  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) <= 1 ||
                  Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) <= 1
              )
          );
        })
        .toBe(true);
      const a = (await ring.boundingBox())!,
        b = (await model.boundingBox())!;
      expect(a.y).toBeGreaterThanOrEqual(b.y + b.height);
      await composer.screenshot({
        path: test.info().outputPath(`composer-${viewport}-${left}-${right}.png`),
      });
    }
    await ring.hover();
    await expect(page.getByRole('dialog')).toContainText('64k / 1,000k');
    await expect(page.getByRole('button', { name: '立即压缩' })).toBeEnabled();
    await page.getByRole('button', { name: '立即压缩' }).click();
    await expect(page.getByRole('status')).toHaveText('/compact');
    await page.getByLabel('用量', { exact: true }).fill('0');
    await expect(page.getByRole('button', { name: /上下文用量.*0 \/ 1,000,000/ })).toBeVisible();
    await page.getByTestId('chat-input').fill('第一行\n第二行\n第三行');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('第一行\n第二行\n第三行');
    await page.getByRole('button', { name: '切换运行状态' }).click();
    await expect(page.getByRole('button', { name: /停止/ })).toBeVisible();
    await page.getByRole('button', { name: /上下文用量/ }).hover();
    await expect(page.getByRole('button', { name: '立即压缩' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await page.getByRole('button', { name: /停止/ }).click();
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

test('dark composer keeps keyboard access and disables compacting an empty conversation', async () => {
  const page = await browser.newPage({ viewport: { width: 640, height: 600 }, reducedMotion: 'reduce' });
  try {
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/composer.html?dark');
    await page.getByLabel('左侧宽度').fill('0');
    await page.getByLabel('右侧宽度').fill('0');
    await page.getByLabel('用量', { exact: true }).fill('0');
    const ring = page.getByTestId('context-window-indicator').getByRole('button');
    await ring.focus();
    const card = page.getByRole('dialog');
    await expect(card).toContainText('0k / 1,000k');
    await expect(page.getByRole('button', { name: '立即压缩' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(card).not.toBeVisible();
    await expect(ring).toBeFocused();
    await page.getByLabel('用量', { exact: true }).fill('1000001');
    await ring.focus();
    await expect(card).toContainText('已用 100%');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: '立即压缩' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toHaveText('/compact');
    await page.getByTestId('composer-container').screenshot({ path: test.info().outputPath('composer-dark.png') });
  } finally { await page.close(); }
});

test('workspace controls stay behind add and command menus in a narrow pane', async () => {
  const page = await browser.newPage({ viewport: { width: 640, height: 720 } });
  try {
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/composer.html');
    await page.getByLabel('左侧宽度').fill('0');
    await page.getByLabel('右侧宽度').fill('0');
    const workspace = page.getByRole('button', { name: '选择工作区', exact: true });
    await workspace.click();
    const workspaceMenu = page.getByRole('menu');
    await expect(workspaceMenu.getByRole('menuitem', { name: /选择工作区/ })).toBeVisible();
    await expect(workspaceMenu.getByRole('separator')).toHaveCount(0);
    await page.keyboard.press('Escape');
    for (const kind of ['add', 'commands']) {
      if (kind === 'add') await page.getByRole('button', { name: '添加附件或功能' }).click();
      else await page.getByTestId('chat-input').fill('/');
      const popup = page.locator(`[data-composer-menu="${kind}"]`);
      await expect(popup).toBeVisible();
      const trigger = (await workspace.boundingBox())!;
      const box = (await popup.boundingBox())!;
      const anchor = (await page.getByTestId('chat-input').boundingBox())!;
      expect(box.width).toBeCloseTo(anchor.width * 0.7, 0);
      expect(box.height).toBeLessThanOrEqual(392);
      const point = { x: trigger.x + trigger.width / 2, y: trigger.y + trigger.height / 2 };
      expect(point.x).toBeGreaterThan(box.x);
      expect(point.x).toBeLessThan(box.x + box.width);
      expect(point.y).toBeGreaterThan(box.y);
      expect(point.y).toBeLessThan(box.y + box.height);
      await expect.poll(() => popup.evaluate((element, position) =>
        element.contains(document.elementFromPoint(position.x, position.y)), point)).toBe(true);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(640);
      await popup.screenshot({ path: resolve(`../../.local/composer-${kind}-layering.png`) });
      await page.keyboard.press('Escape');
    }
  } finally { await page.close(); }
});

test('minimum window keeps a long draft and all actions usable while height changes', async () => {
  const page = await browser.newPage({ viewport: { width: 480, height: 600 } });
  try {
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/composer.html');
    await page.getByLabel('左侧宽度').fill('0');
    await page.getByLabel('右侧宽度').fill('0');
    const draft = Array.from({ length: 24 }, (_, i) => `第${i + 1}行：检查最小窗口下长草稿仍可编辑。`).join('\n');
    const input = page.getByTestId('chat-input');
    await input.fill(draft);
    for (const height of [600, 760, 900, 600]) {
      await page.setViewportSize({ width: 480, height });
      await expect(input).toHaveValue(draft);
      expect(await input.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
      const toolbar = page.getByTestId('composer-container').locator('[data-compact]');
      const buttons = await toolbar.getByRole('button').all();
      const boxes = [];
      for (const button of buttons) if (await button.isVisible()) boxes.push((await button.boundingBox())!);
      expect(boxes.every(box => box.x >= 0 && box.y >= 0 && box.x + box.width <= 480 && box.y + box.height <= height)).toBe(true);
      expect(boxes.every(box => Math.abs(box.y + box.height / 2 - boxes[0].y - boxes[0].height / 2) < 2)).toBe(true);
    }
    await page.getByRole('button', { name: '如何批准操作？' }).click();
    const menu = (await page.getByRole('dialog').boundingBox())!;
    expect(menu.y).toBeGreaterThanOrEqual(0);
    expect(menu.y + menu.height).toBeLessThanOrEqual(600);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText(draft);
  } finally { await page.close(); }
});

test('continuous resizing keeps each toolbar group aligned and its open menu on screen', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/composer.html');
    const composer = page.getByTestId('composer-container');
    const ring = page.getByRole('button', { name: /上下文用量/ });
    await expect(ring).toBeVisible();
    for (const width of [1280, 1120, 1060, 1040, 1020, 1000, 980, 960, 920, 900, 880, 920, 980, 1020, 1060, 1120, 1280]) {
      await page.setViewportSize({ width, height: 720 });
      await expect.poll(async () => {
        const toolbar = composer.locator('[data-compact]');
        const area = (await toolbar.boundingBox())!;
        const groups = await toolbar.locator(':scope > div').all();
        if (groups.length !== 2) return false;
        const groupBoxes = await Promise.all(groups.map(group => group.boundingBox()));
        if (Math.abs(groupBoxes[0]!.y + groupBoxes[0]!.height / 2 - groupBoxes[1]!.y - groupBoxes[1]!.height / 2) > 2) return false;
        for (const group of groups) {
          const buttons = await group.getByRole('button').all();
          const boxes = [];
          for (const button of buttons) {
            if (!(await button.isVisible())) continue;
            const box = (await button.boundingBox())!;
            if (box.x < area.x - 1 || box.x + box.width > area.x + area.width + 1) return false;
            boxes.push(box);
          }
          if (boxes.some(box => Math.abs(box.y + box.height / 2 - boxes[0].y - boxes[0].height / 2) > 2)) return false;
        }
        return true;
      }).toBe(true);
    }
    await page.getByRole('button', { name: '如何批准操作？' }).click();
    const menu = page.getByRole('dialog');
    await expect(menu).toBeVisible();
    for (const width of [1060, 960, 1280]) {
      await page.setViewportSize({ width, height: 600 });
      await expect.poll(async () => {
        const box = (await menu.boundingBox())!;
        return box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= 600;
      }).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(menu).not.toBeVisible();
    await expect(page.getByRole('button', { name: '如何批准操作？' })).toHaveText('工作区内修改');
    await composer.screenshot({ path: test.info().outputPath('composer-after-continuous-resize.png') });
  } finally { await page.close(); }
});

test('queued rows support steering, editing, sorting, removing and folding without stopping delivery', async () => {
  const page = await browser.newPage({ viewport: { width: 1320, height: 760 } });
  try {
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/composer.html');
    const busy = page.getByRole('button', { name: '切换运行状态' });
    await busy.click();
    const input = page.getByTestId('chat-input');
    const panel = page.getByTestId('message-queue');
    for (const msg of ['核对目录结构', '补充验收条件', '先运行组件测试', '删除临时备注']) {
      await input.fill(msg);
      await input.press('Enter');
    }
    const rows = panel.locator('[data-queue-row]');
    await expect(rows).toHaveCount(4);
    const row = (text: string) => rows.filter({ has: page.getByRole('button', { name: text, exact: true }) });
    await row('补充验收条件').getByRole('button', { name: '更多消息操作' }).click();
    await expect(page.getByRole('menuitem')).toHaveCount(2);
    const bounds = (await page.getByTestId('composer-container').boundingBox())!;
    const menu = (await page.getByRole('menu').boundingBox())!;
    const top = Math.max(0, Math.min(bounds.y, menu.y) - 8);
    await page.screenshot({
      path: test.info().outputPath('queue-menu.png'),
      animations: 'disabled',
      clip: { x: bounds.x - 4, y: top, width: bounds.width + 8, height: bounds.y + bounds.height - top },
    });
    await page.getByRole('menuitem', { name: '编辑消息' }).click();
    await expect(panel.getByRole('textbox')).toBeFocused();
    await panel.getByRole('textbox').fill('补充 Windows 验收条件');
    await panel.getByRole('button', { name: '保存', exact: true }).click();
    await row('先运行组件测试').dragTo(row('核对目录结构'));
    await expect(rows.first()).toContainText('先运行组件测试');
    await row('补充 Windows 验收条件').getByRole('button', { name: '引导' }).click();
    await expect(page.getByRole('status').filter({ hasText: '补充 Windows 验收条件' })).toBeVisible();
    await row('删除临时备注').getByRole('button', { name: '将此消息从队列中移除' }).click();
    await expect(rows).toHaveCount(2);
    await rows.first().getByRole('button', { name: '更多消息操作' }).click();
    await page.getByRole('menuitem', { name: '收起队列' }).click();
    await expect(rows).toHaveCount(0);
    await expect(panel.getByRole('button', { name: '展开队列' })).toBeVisible();
    await busy.click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: '核对目录结构' })).toBeVisible();
  } finally { await page.close(); }
});
