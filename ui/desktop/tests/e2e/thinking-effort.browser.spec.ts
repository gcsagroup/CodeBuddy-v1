import { chromium, expect, test, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve } from 'node:path';
import { createServer as createHttpServer } from 'node:http';

let server: ViteDevServer;
let browser: Browser;
test.beforeAll(async () => {
  server = await createServer({
    configFile: resolve('vite.renderer.config.mts'),
    server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  await server.listen();
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
});
test.afterAll(async () => {
  await browser?.close();
  await server?.close();
});

test('slider supports pointer, keyboard and model selection with the new layout', async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(
      server.resolvedUrls!.local[0] + 'tests/browser-fixtures/thinking-effort.html?slider'
    );
    const trigger = page.getByRole('button', { name: '思考强度: 超高', exact: true });
    await trigger.click();
    const card = page.locator('[data-thinking-effort-card]');
    const slider = page.getByRole('slider', { name: '思考强度' });
    await expect(slider).toHaveAttribute('aria-valuetext', '超高');
    const cardBounds = (await card.boundingBox())!;
    expect(cardBounds.width).toBeLessThanOrEqual(260);
    expect(cardBounds.height).toBeLessThanOrEqual(120);
    await card.screenshot({ path: test.info().outputPath('slider-light.png') });
    const fill = page.locator('.thinking-effort-fill');
    const flowingColor = await fill.evaluate((element) => getComputedStyle(element).color);
    const flowPosition = await fill.evaluate(
      (element) => getComputedStyle(element, '::after').transform
    );
    await expect
      .poll(() => fill.evaluate((element) => getComputedStyle(element, '::after').transform))
      .not.toBe(flowPosition);
    const bounds = (await slider.boundingBox())!;
    await page.mouse.move(bounds.x + 10 + (bounds.width - 20) * 0.75, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 10, bounds.y + bounds.height / 2, { steps: 12 });
    await expect(slider).toHaveAttribute('aria-valuetext', '低');
    await expect(card).toHaveAttribute('data-effort', 'low');
    await expect
      .poll(() => fill.evaluate((element) => getComputedStyle(element).color))
      .not.toBe(flowingColor);
    await expect(trigger).toBeVisible(); // Preview has not committed before release.
    await page.mouse.up();
    await expect(page.getByRole('button', { name: '思考强度: 低', exact: true })).toBeVisible();
    await slider.press('End');
    await expect(slider).toHaveAttribute('aria-valuetext', '极致');
    await expect(card).toHaveAttribute('data-effort', 'max');
    await expect(fill).toHaveCSS('color', 'rgb(182, 37, 61)');
    await card.screenshot({ path: test.info().outputPath('slider-max.png') });
    await slider.press('ArrowLeft');
    await expect(slider).toHaveAttribute('aria-valuetext', '超高');
    await page.keyboard.press('Escape');
    await expect(card).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.getByRole('button', { name: 'gpt-6.1-sol', exact: true }).click();
    await expect(card).not.toBeVisible();
    await expect(page.getByRole('status')).toHaveText('模型选择已打开');
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

test('slider fits a narrow dark window and a long model name with reduced motion', async () => {
  const page = await browser.newPage({
    viewport: { width: 320, height: 540 },
    reducedMotion: 'reduce',
  });
  try {
    const model = 'Qwen3.8-27B-direct-A-very-long-model-name';
    await page.addInitScript((data) => Object.assign(window, { thinkingFixture: data }), {
      name: model,
      settings: { options: ['off', 'medium'], value: 'medium', toggle: true },
    });
    await page.goto(
      server.resolvedUrls!.local[0] + 'tests/browser-fixtures/thinking-effort.html?slider&dark'
    );
    await page.getByRole('button', { name: '思考强度: 开启' }).click();
    const card = page.locator('[data-thinking-effort-card]');
    const slider = page.getByRole('slider', { name: '思考强度' });
    await expect(slider).toHaveAttribute('max', '1');
    const bounds = (await card.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
    const label = (await page.getByRole('button', { name: model, exact: true }).boundingBox())!;
    expect(label.x + label.width).toBeLessThan(bounds.x + bounds.width);
    // The global reduced-motion rule uses 0.01ms to retain transition-end events.
    const transitionSeconds = await page
      .locator('.thinking-effort-fill')
      .evaluate((element) => parseFloat(getComputedStyle(element).transitionDuration));
    expect(transitionSeconds).toBeLessThanOrEqual(0.00001);
    await expect(page.locator('.thinking-effort-fill')).toHaveCSS('color', 'rgb(131, 180, 216)');
    expect(
      await page
        .locator('.thinking-effort-fill')
        .evaluate((element) => getComputedStyle(element, '::after').animationName)
    ).toBe('none');
    await card.screenshot({ path: test.info().outputPath('slider-dark-narrow.png') });
    await slider.press('Home');
    await expect(slider).toHaveAttribute('aria-valuetext', '无');
    await expect(card).toHaveAttribute('data-effort', 'off');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    expect(
      await page
        .locator('.thinking-effort-fill')
        .evaluate((element) => getComputedStyle(element, '::after').animationName)
    ).toBe('none');
    await expect(page.getByRole('button', { name: '思考强度: 无' })).toBeVisible();
  } finally {
    await page.close();
  }
});
test('verified Qwen modes select correctly while unknown capability remains visible', async () => {
  test.setTimeout(90000);
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  try {
    page.on('pageerror', (error) => console.error(error.message));
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/thinking-effort.html', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
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
  } finally {
    await page.close();
  }
});

test('SGLang discovered modes reach the rendered picker without unsupported tiers', async () => {
  const model = 'custom-sglang-model';
  const endpoint = createHttpServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models')
      return res.end(JSON.stringify({ data: [{ id: model, owned_by: 'sglang' }] }));
    if (req.url !== '/v1/tokenize') {
      res.statusCode = 404;
      return res.end('{}');
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const effort = JSON.parse(raw).reasoning_effort ?? 'high';
    const tokens = ({ low: [1], high: [2], max: [2] } as Record<string, number[]>)[effort];
    res.statusCode = tokens ? 200 : 400;
    res.end(JSON.stringify(tokens ? { tokens } : { error: 'Unsupported effort' }));
  });
  await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  try {
    const { resolvedModelInfo, thinkingProfile } =
      await import('../../../../runtime/providers.mjs');
    const { modelThinkingOptions } = await import('../../../../runtime/model-settings.mjs');
    const provider = {
      id: 'sglang-browser',
      engine: 'openai_compatible',
      apiUrl: `http://127.0.0.1:${(endpoint.address() as { port: number }).port}`,
      models: [model],
      requiresAuth: false,
    };
    await resolvedModelInfo(provider, model);
    const wire = modelThinkingOptions(thinkingProfile(provider, model));
    const settings = {
      ...wire,
      options: wire.options.map((level: string) => (level === 'none' ? 'off' : level)),
      value: wire.value === 'none' ? 'off' : wire.value,
    };
    await page.addInitScript((data) => Object.assign(window, { thinkingFixture: data }), {
      name: model,
      settings,
    });
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/thinking-effort.html', {
      waitUntil: 'domcontentloaded',
    });
    await page.getByRole('button', { name: '思考强度: 高' }).click();
    await expect(page.getByRole('radio')).toHaveCount(2);
    await expect(page.getByRole('radio', { name: '极致', exact: true })).toHaveCount(0);
    await page.locator('[data-thinking-effort-card]').getByText('低', { exact: true }).click();
    await expect(page.getByRole('button', { name: '思考强度: 低' })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('sglang-thinking.png') });
  } finally {
    await page.close();
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
  }
});
