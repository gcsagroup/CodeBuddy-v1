import { chromium, expect, test } from '@playwright/test';
import { createServer } from 'vite';
import { createServer as createHttpServer } from 'node:http';
import { resolve } from 'node:path';

test('model listing does not hide a generation path failure; correcting it saves the connection', async () => {
  test.setTimeout(120000);
  const { discover, saveProvider, driverProvider } = await import('../../../../runtime/providers.mjs');
  const requests: { path?: string; body: Record<string, unknown> }[] = [];
  const endpoint = createHttpServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ path: req.url, body });
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
    if (req.url === '/tenant/v1/responses') return res.end(JSON.stringify({ output_text: 'OK' }));
    res.statusCode = 400;
    res.end(JSON.stringify({ error: { code: 'unsupported_parameter', param: 'tools', message: 'PRIVATE_FIXTURE_TOKEN' } }));
  });
  await new Promise<void>(done => endpoint.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(endpoint.address() as { port: number }).port}`;
  let state = { providers: [] as Record<string, unknown>[] };
  const store = { read: () => structuredClone(state), update: async (fn: (s: typeof state) => void) => { const next = structuredClone(state); fn(next); state = next; } };
  const input = (data: Record<string, unknown>) => ({
    engine: data.engine, apiUrl: data.api_url, basePath: data.base_path,
    displayName: data.display_name, models: data.models, requiresAuth: false,
  });
  const server = await createServer({ configFile: resolve('vite.renderer.config.mts'), server: { host: '127.0.0.1', port: 0, hmr: false } });
  const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
  try {
    await server.listen();
    const page = await browser.newPage();
    await page.exposeFunction('discoverFixture', data => discover(input(data)));
    await page.exposeFunction('saveFixture', async data => {
      try { await saveProvider(store, input(data)); return {}; }
      catch (error) { const failure = error as { message: string; data: unknown }; return { error: { message: failure.message, data: failure.data } }; }
    });
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/provider-probe.html');
    await page.getByRole('textbox', { name: 'API URL' }).fill(url);
    await page.getByRole('checkbox', { name: 'This provider requires an API key' }).uncheck();
    await page.getByRole('button', { name: 'Load models' }).click();
    await expect(page.getByRole('status')).toContainText('verify the connection before adding');
    await page.getByRole('button', { name: 'Verify and add' }).click();
    await expect(page.getByRole('alert')).toContainText('The service rejected the validation request');
    await expect(page.getByRole('alert')).toContainText('The connection was not saved');
    await expect(page.getByRole('textbox', { name: 'API URL' })).toHaveValue(url);
    await page.getByText('Diagnostic details', { exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('HTTP 400');
    await expect(page.getByRole('alert')).toContainText('unsupported_parameter');
    await page.screenshot({ path: test.info().outputPath('provider-validation-error.png'), fullPage: true });
    await expect(page.getByRole('alert')).not.toContainText('PRIVATE_FIXTURE_TOKEN');
    expect(state.providers).toHaveLength(0);
    await page.getByRole('textbox', { name: 'API Base Path (optional)' }).fill('/tenant/v1/responses');
    await page.getByRole('button', { name: 'Load models' }).click();
    await page.getByRole('button', { name: 'Verify and add' }).click();
    await expect(page.getByText('Connection saved')).toBeVisible();
    expect(state.providers).toHaveLength(1);
    expect((await driverProvider(state.providers[0], 'fixture-model')).protocol).toBe('openai-responses');
    expect(requests.filter(item => item.body.model).map(item => item.path)).toEqual(['/v1/chat/completions', '/tenant/v1/responses']);
    await page.screenshot({ path: test.info().outputPath('provider-probe.png'), fullPage: true });
  } finally {
    await browser.close(); await server.close();
    endpoint.closeAllConnections(); await new Promise<void>(done => endpoint.close(() => done()));
  }
});
