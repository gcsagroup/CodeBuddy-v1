import { chromium, expect, test, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve } from 'node:path';
import { createServer as createHttpServer } from 'node:http';

let server: ViteDevServer;
let browser: Browser;
test.beforeAll(async () => {
  server = await createServer({ configFile: resolve('vite.renderer.config.mts'), server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen();
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
});
test.afterAll(async () => { await browser?.close(); await server?.close(); });
test('verified Qwen modes select correctly while unknown capability remains visible', async () => {
  test.setTimeout(90000);
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  try {
    page.on('pageerror', error => console.error(error.message));
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/thinking-effort.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
    // The first Vite page also compiles the ACP imports; later fixture pages are warm.
    await expect(page.getByText('尚未确认可用档位')).toBeVisible({ timeout: 60000 });
    await page.getByRole('button', { name: '思考强度: 超高' }).click();
    await expect(page.getByRole('radio')).toHaveCount(4);
    await expect(page.getByRole('radio', { name: '高', exact: true })).toHaveCount(0);
    await page.locator('[data-thinking-effort-card]').getByText('低', { exact: true }).click();
    await expect(page.getByRole('button', { name: '思考强度: 低' })).toBeVisible();
    await page.getByRole('button', { name: '思考强度: 低' }).click();
    await page.locator('[data-thinking-effort-card]').getByText('无', { exact: true }).click();
    await expect(page.getByRole('button', { name: '思考强度: 无' })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('thinking-effort.png') });
  } finally { await page.close(); }
});

test('SGLang discovered modes reach the rendered picker without unsupported tiers', async () => {
  const model = 'custom-sglang-model';
  const endpoint = createHttpServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: model, owned_by: 'sglang' }] }));
    if (req.url !== '/v1/tokenize') { res.statusCode = 404; return res.end('{}'); }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const effort = JSON.parse(raw).reasoning_effort ?? 'high';
    const tokens = ({ low: [1], high: [2], max: [2] } as Record<string, number[]>)[effort];
    res.statusCode = tokens ? 200 : 400;
    res.end(JSON.stringify(tokens ? { tokens } : { error: 'Unsupported effort' }));
  });
  await new Promise<void>(resolve => endpoint.listen(0, '127.0.0.1', resolve));
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  try {
    const { resolvedModelInfo, thinkingProfile } = await import('../../../../runtime/providers.mjs');
    const { modelThinkingOptions } = await import('../../../../runtime/model-settings.mjs');
    const provider = { id: 'sglang-browser', engine: 'openai_compatible', apiUrl: `http://127.0.0.1:${(endpoint.address() as { port: number }).port}`, models: [model], requiresAuth: false };
    await resolvedModelInfo(provider, model);
    const wire = modelThinkingOptions(thinkingProfile(provider, model));
    const settings = { ...wire, options: wire.options.map((level: string) => level === 'none' ? 'off' : level), value: wire.value === 'none' ? 'off' : wire.value };
    await page.addInitScript(data => Object.assign(window, { thinkingFixture: data }), { name: model, settings });
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/thinking-effort.html', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '思考强度: 高' }).click();
    await expect(page.getByRole('radio')).toHaveCount(2);
    await expect(page.getByRole('radio', { name: '极致', exact: true })).toHaveCount(0);
    await page.locator('[data-thinking-effort-card]').getByText('低', { exact: true }).click();
    await expect(page.getByRole('button', { name: '思考强度: 低' })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('sglang-thinking.png') });
  } finally {
    await page.close(); endpoint.closeAllConnections(); await new Promise<void>(resolve => endpoint.close(() => resolve()));
  }
});
