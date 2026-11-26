import { chromium, expect, test } from '@playwright/test';
import { createServer } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { createServer as httpServer } from 'node:http';

test('connection center, verified thinking and persisted provider switch work together', async () => {
  test.setTimeout(120000);
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-model-ux-'));
  const { openStore } = await import('../../../../runtime/store.mjs');
  const { Compat } = await import('../../../../runtime/compat.mjs');
  const { discover } = await import('../../../../runtime/providers.mjs');
  const { permissionDriver } = await import('../../../../runtime/tests/fixtures/permission-driver.mjs');
  let calls = 0;
  const endpoint = httpServer((_req, res) => { calls++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture' }] })); });
  await new Promise<void>(done => endpoint.listen(0, '127.0.0.1', done));
  const store = await openStore(root);
  await store.update(state => { state.providers = [{ id: 'p', displayName: 'Fixture', apiUrl: `http://127.0.0.1:${(endpoint.address() as { port: number }).port}`, engine: 'openai_compatible', requiresAuth: false, models: ['fixture'] }]; });
  const host = new Compat(store, { close: async () => {}, permissions: permissionDriver() });
  const server = await createServer({ configFile: resolve('vite.renderer.config.mts'), cacheDir: join(root, 'vite'), optimizeDeps: { entries: ['tests/browser-fixtures/model-connection-center.html'] },
    plugins: [{ name: 'connection-acceptance-bridge', enforce: 'pre', resolveId(source, importer) {
      if (importer?.replaceAll('\\', '/').endsWith('/acp/providers.ts') && source === './acpConnection') return '\0connection-acceptance';
    }, load(id) { if (id === '\0connection-acceptance') return `import { zListProvidersResponse_unstable } from '@aaif/goose-sdk'; export const getAcpClient = async () => ({ extMethod: window.connectionRequest, goose: { providersList_unstable: async params => zListProvidersResponse_unstable.parse(await window.connectionRequest('_goose/unstable/providers/list', params)) } });`; } }],
    server: { host: '127.0.0.1', port: 0, hmr: false } });
  const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : process.platform === 'darwin' ? 'chrome' : undefined });
  try {
    await server.listen();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.exposeFunction('connectionRequest', (method, params) => host.request(method, params, { notify() {} }));
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/model-connection-center.html');
    await expect(page.getByText('正在刷新模型连接')).toHaveCount(0);
    // Reproduce the global bell over both chat and workbench headers.
    const bell = page.getByRole('button', { name: '模型连接通知' });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const assertSeparate = async (name: string) => {
        const button = page.getByRole('button', { name, exact: true });
        const a = (await button.boundingBox())!;
        const b = (await bell.boundingBox())!;
        expect(a.x + a.width <= b.x || b.x + b.width <= a.x, `${width}px ${name}: ${JSON.stringify({ a, b })}`).toBe(true);
        await button.click({ trial: true });
      };
      await assertSeparate('打电话');
      await assertSeparate('打开面板');
      await page.getByRole('button', { name: '打电话', exact: true }).click();
      await page.getByRole('button', { name: '打开面板', exact: true }).click();
      for (const name of ['新建面板', '最大化面板', '关闭面板']) await assertSeparate(name);
      await bell.click();
      await expect(bell).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('Escape');
      await expect(bell).toHaveAttribute('aria-expanded', 'false');
      await page.getByRole('button', { name: '关闭面板', exact: true }).click();
    }
    await expect(page.getByTestId('call-count')).toHaveText('2');
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.getByTestId('composer')).not.toContainText('尚未确认');
    await expect(page.getByTestId('composer')).not.toContainText('极致');
    await page.getByRole('button', { name: '测试模型', exact: true }).click();
    await expect(page.getByText('尚未确认可调档位，使用服务默认。')).toBeVisible();
    await expect(page.getByRole('slider')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByText('切换已确认能力', { exact: true }).click();
    await page.getByRole('button', { name: '思考强度: 高', exact: true }).click();
    await expect(page.getByRole('slider')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByText('模拟连接失败', { exact: true }).click();
    const preview = page.getByRole('region', { name: '模型连接新消息' });
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('刷新失败');
    await page.setViewportSize({ width: 390, height: 844 });
    const previewBounds = (await preview.boundingBox())!;
    const dismissBounds = (await preview.getByRole('button', { name: '收起消息提示' }).boundingBox())!;
    expect(previewBounds.x).toBeGreaterThanOrEqual(0);
    expect(previewBounds.x + previewBounds.width).toBeLessThanOrEqual(390);
    expect(dismissBounds.y - previewBounds.y).toBeLessThan(40);
    await page.screenshot({ path: test.info().outputPath('connection-toast.png') });
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(preview).toHaveCount(0, { timeout: 8000 });
    await expect(page.getByText('模型列表刷新失败', { exact: true })).toHaveCount(0);
    await bell.click();
    await expect(page.getByText('模型列表刷新失败', { exact: true })).toBeVisible();
    const center = page.locator('.model-connection-center');
    expect((await center.boundingBox())!.x).toBeGreaterThan(700);
    await page.getByRole('button', { name: '暂时收起' }).click();
    await page.getByRole('button', { name: '模型连接通知' }).click();
    await page.screenshot({ path: test.info().outputPath('connection-center.png') });
    const toggle = page.getByRole('switch', { name: '验收连接 连接' });
    const heading = page.getByRole('heading', { name: '验收连接', exact: true });
    const toggleBounds = (await toggle.boundingBox())!;
    const headingBounds = (await heading.boundingBox())!;
    expect(Math.abs(toggleBounds.y + toggleBounds.height / 2 - headingBounds.y - headingBounds.height / 2)).toBeLessThan(4);
    const enabledColor = await toggle.evaluate(element => getComputedStyle(element).backgroundColor);
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect.poll(() => toggle.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(enabledColor);
    await page.getByRole('button', { name: '关闭设置' }).click();
    await page.getByRole('button', { name: '打开设置' }).click();
    await expect(toggle).not.toBeChecked();
    expect(store.read(['providers']).providers[0].enabled).toBe(false);
    expect((await openStore(root)).read(['providers']).providers[0].enabled).toBe(false);
    await expect(discover(store.read(['providers']).providers[0], store.read(['providers']).providers[0])).rejects.toThrow('disabled');
    expect(calls).toBe(0);
    await toggle.click();
    await expect(toggle).toBeChecked();
    await discover(store.read(['providers']).providers[0], store.read(['providers']).providers[0]);
    expect(calls).toBeGreaterThan(0);
    // A rejected switch must not push the configuration action outside the card.
    host.reviewExecutions.set('layout-check', 'p');
    await toggle.click();
    await expect(toggle).toBeChecked();
    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    const card = page.getByTestId('provider-card-p');
    const configure = card.getByRole('button', { name: '配置', exact: true });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const cardBounds = (await card.boundingBox())!;
      const alertBounds = (await alert.boundingBox())!;
      const buttonBounds = (await configure.boundingBox())!;
      expect(buttonBounds.y).toBeGreaterThanOrEqual(alertBounds.y + alertBounds.height);
      expect(buttonBounds.y + buttonBounds.height).toBeLessThanOrEqual(cardBounds.y + cardBounds.height);
      await expect(configure).toBeVisible();
    }
    host.reviewExecutions.clear();
    await page.screenshot({ path: test.info().outputPath('provider-switch-feedback.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('connection-narrow.png') });
  } finally {
    await browser.close(); await server.close(); await host.close();
    endpoint.closeAllConnections(); await new Promise<void>(done => endpoint.close(() => done()));
    if (dirname(resolve(root)) === resolve(tmpdir()) && basename(root).startsWith('codebuddy-model-ux-')) await rm(root, { recursive: true, force: true });
  }
});
