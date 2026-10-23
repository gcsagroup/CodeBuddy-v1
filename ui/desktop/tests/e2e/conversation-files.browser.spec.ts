import { chromium, expect, test, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve, dirname, basename } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
let server: ViteDevServer;
let browser: Browser;
let cacheDirectory: string;

test.beforeAll(async () => {
  server = await createServer({
    configFile: resolve('vite.renderer.config.mts'),
    cacheDir: (cacheDirectory = await mkdtemp(resolve(tmpdir(), 'codebuddy-file-card-vite-'))),
    plugins: [
      {
        name: 'file-fixture-boundary',
        enforce: 'pre',
        resolveId(source, importer) {
          if (
            importer?.replaceAll('\\', '/').endsWith('/useWorkspaceFileReferences.ts') &&
            source === '../acp/chatSessionStore'
          )
            return '\0file-fixture-store';
        },
        load(id) {
          if (id === '\0file-fixture-store')
            return `export const useAcpChatSessionSnapshot = () => ({ session: { working_dir: location.search.includes('mac') ? '/Users/test/project' : 'D:/fixture', extension_data: { workspaceBinding: 'bound' } } });`;
        },
      },
    ],
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
    dirname(resolve(cacheDirectory)) === resolve(tmpdir()) &&
    basename(cacheDirectory).startsWith('codebuddy-file-card-vite-')
  )
    await rm(cacheDirectory, { recursive: true, force: true });
});

for (const platform of ['windows', 'mac']) {
  test(`one file card shows only recorded changes with expansion on ${platform}`, async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto(
        server.resolvedUrls!.local[0] + `tests/browser-fixtures/conversation-files.html?${platform}`
      );
      await expect(
        page.getByRole('button', { name: '本轮修改了 4 个文件', exact: true })
      ).toBeVisible();
      await expect(page.getByRole('listitem')).toHaveCount(3);
      await expect(page.getByText('pelican_bike.html', { exact: true })).toHaveCount(1);
      await expect(page.getByText('相关文件', { exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: '查看变更', exact: true }).click();
      await expect(page.locator('output')).toContainText('"turnId":"turn"');
      await page.getByRole('button', { name: '再显示 1 个文件', exact: true }).click();
      await expect(page.getByRole('listitem')).toHaveCount(4);
      await expect(page.getByRole('button', { name: 'README.md', exact: true })).toHaveCount(0);
      const changePath = `${platform === 'mac' ? '/Users/test/project' : 'D:/fixture'}/src/components/controls.tsx`;
      await page.getByRole('button', { name: changePath, exact: true }).click();
      await expect(page.locator('output')).toContainText(`"filePath":"${changePath}"`);
      await page.screenshot({ path: test.info().outputPath('file-card-wide.png'), fullPage: true });
      await page.setViewportSize({ width: 420, height: 760 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      );
      await page.screenshot({
        path: test.info().outputPath('file-card-narrow.png'),
        fullPage: true,
      });
      await page.getByRole('button', { name: '本轮修改了 4 个文件', exact: true }).click();
      await expect(page.getByRole('listitem')).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
}
