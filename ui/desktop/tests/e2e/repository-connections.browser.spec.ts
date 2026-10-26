import { chromium, expect, test, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve, dirname, basename } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
let server: ViteDevServer;
let browser: Browser;
let cache: string;
test.beforeAll(async () => {
  server = await createServer({
    configFile: resolve('vite.renderer.config.mts'),
    cacheDir: (cache = await mkdtemp(resolve(tmpdir(), 'codebuddy-repositories-vite-'))),
    plugins: [
      {
        name: 'repository-account-fixture',
        enforce: 'pre',
        resolveId(source, importer) {
          const file = importer?.replaceAll('\\', '/') ?? '';
          if (file.endsWith('/auth/GitHubConnections.tsx')) {
            if (source === '../../../acp/extensions' || source === '../../../acp/diagnostics')
              return '\0repository-fixture';
          }
          if (!file.endsWith('/toolbox/ToolboxView.tsx')) return;
          if (source === '../../acp/toolbox' || source === '../ConfigContext')
            return '\0repository-fixture';
          if (source === '../../utils/workingDir') return '\0repository-directory';
          if (
            source === '../settings/extensions/ExtensionsSection' ||
            source === '../skills/SkillManager'
          )
            return '\0repository-empty';
        },
        load(id) {
          if (id === '\0repository-empty') return 'export default function Empty(){ return null; }';
          if (id === '\0repository-directory')
            return 'export const getInitialWorkingDir=()=>"/fixture";';
          if (id === '\0repository-fixture')
            return `
          import { buildToolboxModel } from '/src/components/toolbox/toolboxModel.ts';
          const mode = new URLSearchParams(location.search).get('state');
          const extensions = [{ type:'builtin', name:'git', enabled:true }, {type:'streamable_http',name:'github_official',configKey:'github_official',uri:'https://api.githubcopilot.com/mcp/',enabled:true}];
          let attempts = 0;
          export const getConfiguredExtensions = async () => ({ extensions, warnings:[] });
          export const testConfigExtension = async () => ({ success: mode !== 'offline' && mode !== 'signed-out' });
          export const connectGitHubMcp = async () => ({ success: mode !== 'offline' || ++attempts > 1, code:'connection_failed' });
          export const loadToolbox = async () => ({model:buildToolboxModel({extensions,apps:[],skills:[]}),errors:{},warnings:[]});
          export const useConfig = () => ({extensionsList:extensions, setExtensionEnabled:async()=>{}});
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
    cache &&
    dirname(resolve(cache)) === resolve(tmpdir()) &&
    basename(cache).startsWith('codebuddy-repositories-vite-')
  )
    await rm(cache, { recursive: true, force: true });
});
for (const view of ['settings', 'toolbox']) {
  test(`${view} has one compact account flow, retries errors and keeps login available`, async () => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const open = async (state: string) => {
      await page.goto(
        server.resolvedUrls!.local[0] +
          `tests/browser-fixtures/repository-connections.html?view=${view}&state=${state}`
      );
      if (view === 'toolbox') {
        await page.getByRole('tab', { name: '外部 MCP', exact: true }).click();
        await expect(page.getByRole('button', { name: '代码仓库', exact: true })).toHaveCount(0);
        await page.getByRole('tab', { name: '内置能力', exact: true }).click();
        await expect(page.getByRole('button', { name: '代码仓库', exact: true })).toHaveCount(0);
        await page.getByRole('tab', { name: '技能', exact: true }).click();
        await expect(page.getByRole('heading', { name: '内置技能', exact: true })).toBeVisible();
        if (state === 'connected') {
          await page.screenshot({
            path: test.info().outputPath('repository-built-in-skills.png'),
            fullPage: true,
            animations: 'disabled',
          });
        }
        await page.getByRole('button', { name: '代码仓库', exact: true }).click();
      }
    };
    await open('connected');
    await expect(page.getByText('GitHub：已连接', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
    await expect(page.getByText('高级账号选项', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '停用本地 Git', exact: true })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: '对新任务停用 GitHub', exact: true })
    ).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath(`${view}-connected.png`),
      fullPage: true,
      animations: 'disabled',
    });
    await open('offline');
    await expect(page.getByRole('alert')).toContainText('GitHub 连接未完成');
    await page.getByRole('button', { name: '连接 GitHub', exact: true }).click();
    await expect(page.getByText('GitHub：已连接', { exact: true })).toBeVisible();
    await open('signed-out');
    await page.getByRole('button', { name: '连接 GitHub', exact: true }).click();
    await expect(page.getByText('TEST-CODE', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '取消登录', exact: true }).click();
    await expect(page.getByText('TEST-CODE', { exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 650, height: 800 });
    await page.screenshot({
      path: test.info().outputPath(`${view}-signed-out-narrow.png`),
      fullPage: true,
      animations: 'disabled',
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    expect(errors).toEqual([]);
    await page.close();
  });
}
