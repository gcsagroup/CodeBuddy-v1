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
    optimizeDeps: {
      entries: ['tests/browser-fixtures/settings-navigation.html'],
      include: ['zod', '@modelcontextprotocol/ext-apps/app-bridge'],
    },
    cacheDir: (cacheDirectory = await mkdtemp(resolve(tmpdir(), 'codebuddy-settings-vite-'))),
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
    basename(cacheDirectory).startsWith('codebuddy-settings-vite-')
  )
    await rm(cacheDirectory, { recursive: true, force: true });
});

test('settings no longer exposes storage management or a storage search destination', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(
      server.resolvedUrls!.local[0] + 'tests/browser-fixtures/settings-navigation.html'
    );
    await expect(page.getByTestId('settings-navigation')).toBeVisible();
    await expect(page.getByTestId('settings-nav-keyboard')).toBeVisible();
    await expect(page.getByTestId('settings-nav-sharing')).toHaveCount(0);
    await expect(page.getByText('CodeBuddy 服务器', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('settings-nav-storage')).toHaveCount(0);
    await page.getByTestId('settings-search').fill('存储');
    await expect(page.getByTestId('settings-nav-storage')).toHaveCount(0);
    await expect(page.getByText('存储管理', { exact: true })).toHaveCount(0);
    await page.getByTestId('settings-search').fill('');
    await expect(page.getByTestId('settings-nav-keyboard')).toBeVisible();
    await expect(page.getByTestId('settings-nav-sharing')).toHaveCount(0);
    await expect(page.getByText('CodeBuddy 服务器', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('settings.png') });
  } finally {
    await page.close();
  }
});

test('desktop categories, removed input settings, and model cards', async () => {
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } });
  try {
    page.on('pageerror', (error) => console.error(error.message));
    await page.route(/\/src\/components\/ConfigContext\.tsx(?:\?|$)/, (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: `export function useConfig() { return { config: {}, providersList: [], extensionsList: [], blockedMutationKeys: [], upsert: async () => {}, read: async () => null, getExtensions: async () => [], getProviders: async () => [] }; }`,
      })
    );
    await page.route(/\/src\/acp\/acpConnection\.ts(?:\?|$)/, async (route) => {
      if (new URL(route.request().url()).searchParams.has('original')) return route.continue();
      return route.fulfill({
        contentType: 'application/javascript',
        body: `export * from '/src/acp/acpConnection.ts?original';
               export { getAcpClient, getAcpControlClient } from '/tests/browser-fixtures/models-runtime-api.ts';`,
      });
    });
    await page.goto(
      server.resolvedUrls!.local[0] + 'tests/browser-fixtures/settings-navigation.html'
    );
    await expect(page.getByTestId('settings-nav-input')).toHaveCount(0);
    const search = page.getByTestId('settings-search');
    await search.fill('拼写');
    await expect(page.getByRole('navigation').getByRole('button')).toHaveCount(0);
    await search.fill('模型');
    await page.getByTestId('settings-nav-models').click();
    const connections = page.getByRole('button', { name: '模型与连接', exact: true });
    const generation = page.getByRole('button', { name: '图片与视频生成', exact: true });
    await expect(connections).toBeVisible();
    await expect(generation).toBeVisible();
    expect((await connections.boundingBox())!.y).toBe((await generation.boundingBox())!.y);
    await search.fill('');
    await page.screenshot({ path: test.info().outputPath('settings-desktop.png') });
    for (const [key, name] of Object.entries({
      connections: '模型与连接',
      generation: '图片与视频生成',
      vision: '图像理解',
      subagents: '子 Agent',
      compaction: '上下文压缩',
      context: '上下文容量',
    })) {
      const entry = page.getByRole('button', { name, exact: true });
      await entry.click();
      const detail = page.locator(`[data-detail="${key}"]`);
      await expect(detail).toBeVisible();
      if (key === 'vision')
        await expect(detail.getByRole('combobox')).toContainText('CUA-S1-Qwen3.5-4B');
      if (key === 'generation')
        await expect(detail.getByRole('button', { name: '添加服务' })).toBeVisible();
      if (key === 'context') await expect(detail.getByRole('spinbutton').first()).toBeEnabled();
      await page.screenshot({ path: test.info().outputPath(`runtime-${key}.png`) });
      if (key === 'subagents') {
        await detail.getByRole('button', { name: '添加子 Agent', exact: true }).click();
        await expect(detail.getByRole('textbox').first()).toBeVisible();
        await page.screenshot({ path: test.info().outputPath('subagent-editor.png') });
        await detail.getByRole('button', { name: '取消', exact: true }).click();
      }
      await page.getByRole('button', { name: '返回菜单' }).click();
      await expect(entry).toBeFocused();
    }
    for (const category of ['app', 'keyboard', 'pets', 'memory', 'auth', 'security']) {
      await page.getByTestId(`settings-nav-${category}`).click();
      const content = page.locator(`[data-settings-page="${category}"]`);
      await expect(content).toBeVisible();
      await expect(content).not.toBeEmpty();
      await page.screenshot({ path: test.info().outputPath(`settings-${category}.png`) });
    }
    await page.getByTestId('settings-nav-chat').click();
    await expect(page.getByRole('button', { name: 'CodeBuddy 规则', exact: true })).toBeVisible();
    const display = page.getByRole('button', { name: '工具过程显示', exact: true });
    await display.click();
    await expect(display).toBeHidden();
    await page.getByRole('button', { name: '返回菜单' }).click();
    await expect(display).toBeFocused();
  } finally {
    await page.close();
  }
});

test('compact settings reserve the width for content and support keyboard dismissal', async () => {
  const page = await browser.newPage({
    viewport: { width: 480, height: 740 },
    colorScheme: 'dark',
    locale: 'zh-CN',
  });
  try {
    await page.goto(
      server.resolvedUrls!.local[0] + 'tests/browser-fixtures/settings-navigation.html'
    );
    const toggle = page.locator('button[aria-controls="settings-category-nav"]');
    const nav = page.getByRole('navigation');
    await expect(toggle).toBeVisible();
    await expect(nav).toBeHidden();
    await toggle.click();
    await expect(nav).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(nav).toBeHidden();
    await expect(toggle).toBeFocused();
    await page.getByTestId('settings-search').fill('模型');
    await page.getByTestId('settings-nav-models').click();
    await expect(nav).toBeHidden();
    await expect(toggle).toHaveAccessibleName('模型与运行');
    const cards = page.getByRole('main').getByRole('button');
    const first = await cards.first().boundingBox();
    const second = await cards.nth(1).boundingBox();
    expect(second!.y).toBeGreaterThan(first!.y);
    const overflow = await page
      .getByRole('main')
      .evaluate((main) =>
        Array.from(main.querySelectorAll('button')).some(
          (button) => button.getBoundingClientRect().right > main.getBoundingClientRect().right
        )
      );
    expect(overflow).toBe(false);
    await page.screenshot({ path: test.info().outputPath('settings-compact.png') });
  } finally {
    await page.close();
  }
});

test('security and credential controls fit narrow and wide settings panels', async () => {
  const page = await browser.newPage({ viewport: { width: 1220, height: 850 } });
  try {
    await page.route(/\/src\/components\/ConfigContext\.tsx(?:\?|$)/, (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: `export { useSecurityFixtureConfig as useConfig } from '/tests/browser-fixtures/models-runtime-api.ts';`,
      })
    );
    await page.route(/\/src\/acp\/acpConnection\.ts(?:\?|$)/, async (route) => {
      if (new URL(route.request().url()).searchParams.has('original')) return route.continue();
      return route.fulfill({
        contentType: 'application/javascript',
        body: `export * from '/src/acp/acpConnection.ts?original';
          export { getAcpClient, getAcpControlClient } from '/tests/browser-fixtures/models-runtime-api.ts';`,
      });
    });
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/settings-navigation.html?credentialFixture');
    for (const width of [1220, 440]) {
      await page.setViewportSize({ width, height: 850 });
      for (const category of ['security', 'auth']) {
        if (width < 640) await page.locator('button[aria-controls="settings-category-nav"]').click();
        await page.getByTestId(`settings-nav-${category}`).click();
        const content = page.locator(`[data-settings-page="${category}"]`);
        await expect(content).toBeVisible();
        if (category === 'security') {
          await expect(content.getByRole('spinbutton')).toBeVisible();
          const token = content.locator('input[type="password"]:visible');
          await expect(token).toBeVisible();
          await expect(token).toHaveAttribute('id', /.+/);
          const mainSwitch = content.getByRole('switch').first();
          await mainSwitch.click();
          await expect(content.getByRole('spinbutton')).toHaveCount(0);
          await mainSwitch.click();
          await expect(token).toBeVisible();
        } else {
          const row = content.getByTestId('auth-secret-row');
          await expect(row).toContainText('Fixture Provider');
          await expect(row.getByRole('button')).toHaveCount(2);
          for (const button of await row.getByRole('button').all()) await expect(button).toBeVisible();
        }
        expect(await content.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
        await page.screenshot({ path: test.info().outputPath(`${category}-${width}.png`) });
      }
    }
  } finally {
    await page.close();
  }
});

test('behavior settings keep rules and display choices readable at narrow and wide widths', async () => {
  for (const width of [1220, 440]) {
    const page = await browser.newPage({ viewport: { width, height: 850 } });
    try {
      await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/settings-navigation.html?behaviorFixture');
      if (width < 640) await page.locator('button[aria-controls="settings-category-nav"]').click();
      await page.getByTestId('settings-nav-chat').click();
      const panel = page.locator('[data-settings-page="chat"]').filter({ has: page.locator('[data-entry="instructions"]') });
      const rules = panel.getByRole('button', {name: 'CodeBuddy 规则', exact: true});
      const display = panel.getByRole('button', {name: '工具过程显示', exact: true});
      await expect(rules).toBeVisible();
      await expect(display).toBeVisible();
      const rulesBox = (await rules.boundingBox())!;
      const displayBox = (await display.boundingBox())!;
      if (width >= 640) {
        expect(Math.abs(displayBox.y - rulesBox.y)).toBeLessThan(1);
        expect(displayBox.x).toBeGreaterThanOrEqual(rulesBox.x + rulesBox.width);
      } else {
        expect(displayBox.y).toBeGreaterThanOrEqual(rulesBox.y + rulesBox.height);
        expect(Math.abs(displayBox.x - rulesBox.x)).toBeLessThan(1);
      }
      expect(Math.abs(displayBox.width - rulesBox.width)).toBeLessThan(1);
      await page.screenshot({path: test.info().outputPath(`behavior-${width}.png`)});
      await rules.click();
      const editor = panel.getByRole('textbox');
      await expect(editor).toHaveValue('请用简体中文回复。');
      await editor.fill('请按项目规则回复。');
      await panel.getByRole('button', {name: '保存', exact: true}).click();
      await expect(panel.getByRole('status')).toBeVisible();
      expect(await panel.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({path: test.info().outputPath(`behavior-rules-${width}.png`)});
      await panel.getByRole('button', {name: '返回菜单'}).click();
      await expect(rules).toBeFocused();
      await display.click();
      const detail = panel.locator('[data-detail="display"]');
      await detail.locator('label').filter({ has: page.locator('input[value="detailed"]') }).click();
      await expect(detail.locator('input[value="detailed"]')).toBeChecked();
      expect(await panel.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({path: test.info().outputPath(`behavior-display-${width}.png`)});
    } finally {
      await page.close();
    }
  }
});
