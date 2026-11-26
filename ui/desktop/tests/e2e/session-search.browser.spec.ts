import { chromium, expect, test } from '@playwright/test';
import { createServer } from 'vite';
import { resolve } from 'node:path';
test('search dialog supports keyboard selection, empty results and narrow windows', async () => {
  test.setTimeout(120000);
  const server = await createServer({ configFile: resolve('vite.renderer.config.mts'),
    plugins: [{ name: 'search-fixture', enforce: 'pre', resolveId(source, importer) {
      if (importer?.replaceAll('\\', '/').endsWith('/SessionSearchDialog.tsx') && source === '../../acp/sessions') return '\0search-fixture';
    }, load(id) { if (id === '\0search-fixture') return `export async function acpListSessions(cursor, filter) { return { sessions: filter.keyword === '不存在' ? [] : [{id:'fixture-chat',name:'模型连接排查',workingDir:'D:/CodeBuddy',updatedAt:'2026-11-24',createdAt:'2026-11-24',messageCount:2}],nextCursor:null }; }`; } }],
    server: { host: '127.0.0.1', port: 0, hmr: false } });
  const browser = await chromium.launch({ channel: 'msedge' });
  try {
    await server.listen(); const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/session-search.html');
    await page.getByRole('button', { name: '搜索会话', exact: true }).click();
    const input = page.getByRole('combobox'); await expect(input).toBeFocused();
    await expect(page.getByRole('option')).toContainText('模型连接排查');
    await input.fill('不存在'); await expect(page.getByRole('option')).toHaveCount(0);
    await expect(page.getByText('没有匹配的会话，试试其他关键词。')).toBeVisible();
    await input.fill('模型'); await expect(page.getByRole('option')).toBeVisible();
    const bounds = (await page.getByRole('dialog').boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: test.info().outputPath('search.png'), animations: 'disabled' });
    await input.press('ArrowDown'); await input.press('Enter');
    await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.locator('output')).toHaveText('fixture-chat');
    await page.getByRole('button', { name: '搜索会话', exact: true }).click(); await input.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } finally { await browser.close(); await server.close(); }
});
