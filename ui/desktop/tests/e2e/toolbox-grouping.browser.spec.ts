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
    cacheDir: (cacheDirectory = await mkdtemp(resolve(tmpdir(), 'codebuddy-toolbox-vite-'))),
    // This isolated page does not use the full Electron renderer entry points.
    optimizeDeps: { entries: ['tests/browser-fixtures/toolbox-grouping.html'] },
    plugins: [
      {
        name: 'toolbox-fixture-boundaries',
        enforce: 'pre',
        resolveId(source, importer) {
          if (!importer?.replaceAll('\\', '/').endsWith('/toolbox/ToolboxView.tsx')) return;
          if (source === '../../acp/toolbox' || source === '../ConfigContext')
            return '\0toolbox-fixture-data';
          if (source === '../../utils/workingDir') return '\0toolbox-fixture-directory';
          if (source === '../settings/extensions/ExtensionsSection')
            return '\0toolbox-fixture-empty';
          if (source === '../skills/SkillManager') return '\0toolbox-fixture-empty';
        },
        load(id) {
          if (id === '\0toolbox-fixture-empty')
            return 'export default function Empty() { return null; }';
          if (id === '\0toolbox-fixture-directory')
            return 'export const getInitialWorkingDir = () => "/fixture";';
          if (id === '\0toolbox-fixture-data')
            return `
          import { buildToolboxModel } from '/src/components/toolbox/toolboxModel.ts';
          const extensions = [
            { type: 'builtin', name: 'qwen_computer', enabled: false },
            { type: 'builtin', name: 'git', enabled: true },
            { type: 'streamable_http', name: 'github_official', uri: 'https://api.githubcopilot.com/mcp/', enabled: false },
            { type: 'streamable_http', name: 'weather_fixture', uri: 'https://example.com/mcp/', enabled: false }
          ];
          export const loadToolbox = async () => ({ model: buildToolboxModel({ extensions, apps: [], skills: [
            { type: 'builtinSkill', name: 'modern-web-guidance', description: 'Web guidance', path: '/builtin/modern-web-guidance' },
            ...['code-navigation', 'versioned-docs', 'media-quality', 'web-acceptance'].map(name => ({ type: 'builtinSkill', name, description: name, path: '/builtin/' + name })),
            { type: 'builtinSkill', name: 'computer-use', description: 'Desktop guide', path: '/builtin/computer-use' }
          ] }), errors: {}, warnings: [] });
          const config = { extensionsList: [], setExtensionEnabled: async (name, enabled) => { extensions.find(e => e.name === name).enabled = enabled; } };
          export const useConfig = () => config;
        `;
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
    basename(cacheDirectory).startsWith('codebuddy-toolbox-vite-')
  )
    await rm(cacheDirectory, { recursive: true, force: true });
});

test('grouped toolbox supports search, tabs and independent tool toggles at wide and narrow widths', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/toolbox-grouping.html');
    await expect(page.getByRole('region', { name: '内置能力', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '桌面操作指南', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '代码仓库', exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: '本地 Git', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'GitHub', exact: true })).toHaveCount(0);
    await page.getByRole('switch', { name: '打开Computer Use', exact: true }).click();
    await expect(page.getByRole('switch', { name: '关闭Computer Use', exact: true })).toBeChecked();
    await page.getByPlaceholder('搜索工具').fill('modern-web-guidance');
    await expect(page.getByRole('button', { name: '现代 Web 开发指南', exact: true })).toBeVisible();
    await page.getByPlaceholder('搜索工具').fill('computer-use');
    await expect(page.getByRole('button', { name: '桌面操作指南', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '代码仓库', exact: true })).toHaveCount(0);
    await page.getByPlaceholder('搜索工具').fill('github');
    await expect(page.getByRole('button', { name: '代码仓库', exact: true })).toBeVisible();
    await page.getByPlaceholder('搜索工具').fill('');
    await page.getByRole('tab', { name: '外部 MCP', exact: true }).click();
    await expect(page.getByRole('button', { name: '桌面操作指南', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '代码仓库', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'weather_fixture', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: '全部', exact: true }).click();
    const development = page.locator('summary').filter({ hasText: '开发与排错' });
    await development.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: '代码定义与引用', exact: true })).toBeVisible();
    await development.click();
    await expect(page.getByRole('button', { name: '代码定义与引用', exact: true })).toBeHidden();
    await page.getByPlaceholder('搜索工具').fill('code-navigation');
    await expect(page.getByRole('button', { name: '代码定义与引用', exact: true })).toBeVisible();
    await page.getByPlaceholder('搜索工具').fill('');
    for (const group of await page.locator('.toolbox-group').all()) {
      if (await group.getAttribute('open') === null) await group.locator('summary').click();
    }
    await page.screenshot({ path: test.info().outputPath('toolbox-wide.png'), fullPage: true });
    await page.setViewportSize({ width: 650, height: 1000 });
    await expect(page.getByRole('button', { name: '桌面操作指南', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await page.screenshot({ path: test.info().outputPath('toolbox-narrow.png'), fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});
