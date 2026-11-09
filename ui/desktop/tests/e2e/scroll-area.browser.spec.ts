/* global HTMLDetailsElement */
import { chromium, expect, test, type Browser, type Page, type Locator } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve, dirname, basename } from 'node:path';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let cacheDirectory: string;
const historyCacheRoot = resolve('../../.local');

test.beforeAll(async () => {
  await mkdir(historyCacheRoot, { recursive: true });
  server = await createServer({
    configFile: resolve('vite.renderer.config.mts'),
    // Do not invalidate the running desktop's optimized dependencies.
    cacheDir: (cacheDirectory = await mkdtemp(resolve(historyCacheRoot, 'codepro-scroll-vite-'))),
    optimizeDeps: { entries: ['tests/browser-fixtures/scroll-area.html'] },
    server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  await server.listen();
  browser = await chromium.launch({
    channel:
      process.platform === 'win32'
        ? 'msedge'
        : process.platform === 'darwin'
          ? 'chrome'
          : undefined,
  });
  page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
});

test.afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (
    cacheDirectory &&
    dirname(resolve(cacheDirectory)) === historyCacheRoot &&
    basename(cacheDirectory).startsWith('codepro-scroll-vite-')
  ) {
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});

for (const anchoring of ['auto', 'none'] as const)
  test(`prepending older turns preserves the visible paragraph before every paint (${anchoring})`, async () => {
    await page.goto(
      `${server.resolvedUrls!.local[0]}tests/browser-fixtures/scroll-area.html?history`
    );
    const viewport = page.locator('[data-radix-scroll-area-viewport]');
    await expect(page.getByText('History question 47', { exact: true })).toBeAttached();
    await page.getByRole('button', { name: 'Latest', exact: true }).click();
    await viewport.hover();
    await page.mouse.wheel(0, -50);
    await settle();
    // Put an actual reading paragraph near the boundary, then let the real
    // sentinel load the preceding batch. Record all paints, including any flash.
    const samples = await viewport.evaluate(async (element, anchoring) => {
      element.style.overflowAnchor = anchoring;
      const paragraphs = Array.from(element.querySelectorAll('p'));
      const paragraph = paragraphs.find((p) =>
        p.textContent?.includes('History answer 44 paragraph 0.')
      )!;
      const beforeCount = element.querySelectorAll('section').length;
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
      const top = paragraph.getBoundingClientRect().top;
      const offsets: number[] = [];
      for (let frame = 0; frame < 24; frame++) {
        await new Promise(requestAnimationFrame);
        offsets.push(paragraph.isConnected ? paragraph.getBoundingClientRect().top - top : 100000);
      }
      return { offsets, beforeCount, afterCount: element.querySelectorAll('section').length };
    }, anchoring);
    expect(samples.afterCount).toBeGreaterThan(samples.beforeCount);
    expect(Math.max(...samples.offsets.map(Math.abs))).toBeLessThan(2);
  });

test('continued upward wheel navigation loads all older turns without reversing reading position', async () => {
  await page.goto(
    `${server.resolvedUrls!.local[0]}tests/browser-fixtures/scroll-area.html?history`
  );
  const viewport = page.locator('[data-radix-scroll-area-viewport]');
  await expect(page.getByText('History question 47', { exact: true })).toBeAttached();
  await page.getByRole('button', { name: 'Latest', exact: true }).click();
  await viewport.hover();
  await viewport.evaluate((element) => {
    const anchor = element.querySelector('p')!;
    const samples: number[] = [];
    Object.assign(window, { historyWheelSamples: samples });
    const capture = () => {
      samples.push(anchor.isConnected ? anchor.getBoundingClientRect().top : -100000);
      if (element.querySelector('[data-history-sentinel]') || element.scrollTop > 0)
        requestAnimationFrame(capture);
    };
    requestAnimationFrame(capture);
  });
  for (let step = 0; step < 100; step++) {
    await page.mouse.wheel(0, -600);
    if (
      await viewport.evaluate(
        (element) => !element.querySelector('[data-history-sentinel]') && element.scrollTop === 0
      )
    )
      break;
  }
  await settle();
  await expect(page.getByText('History question 0', { exact: true })).toBeVisible();
  const reversals = await page.evaluate(() => {
    const samples = (window as unknown as { historyWheelSamples: number[] }).historyWheelSamples;
    return samples.slice(1).filter((top, index) => top < samples[index] - 2);
  });
  expect(reversals).toEqual([]);
});

test('automatic thought collapse keeps the final result in view without reserved blank space', async () => {
  await page.goto(
    `${server.resolvedUrls!.local[0]}tests/browser-fixtures/scroll-area.html?auto-fold`
  );
  await page.getByRole('button', { name: 'Latest', exact: true }).click();
  await settle();
  await page.getByRole('button', { name: 'Finish run', exact: true }).click();
  const viewport = page.locator('[data-radix-scroll-area-viewport]');
  await expect
    .poll(async () => {
      const bounds = (await viewport.boundingBox())!;
      const result = (await page
        .getByText('Final verified result', { exact: true })
        .boundingBox())!;
      return result.y >= bounds.y && result.y + result.height <= bounds.y + bounds.height;
    })
    .toBe(true);
});

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`settling a turn preserves the reader and releases removed content space (${reducedMotion})`, async () => {
    await page.emulateMedia({ reducedMotion });
    await page.goto(
      `${server.resolvedUrls!.local[0]}tests/browser-fixtures/scroll-area.html?auto-fold&turn-group`
    );
    await page.getByRole('button', { name: 'Latest', exact: true }).click();
    await settle();
    const viewport = page.locator('[data-radix-scroll-area-viewport]');
    await page.getByText('Final verified result', { exact: true }).hover();
    await page.mouse.wheel(0, -120);
    await expect(page.getByRole('status')).toHaveText('Reading history');
    await settle();
    const reading = page.locator('.codepro-thinking-record').last().getByRole('button');
    const before = (await reading.boundingBox())!;
    await page.getByRole('button', { name: 'Finish run', exact: true }).click();
    await settle();
    await expect(page.getByRole('button', { name: 'Turn work', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    await expect(reading).toBeVisible();
    expect(Math.abs((await reading.boundingBox())!.y - before.y)).toBeLessThanOrEqual(2);
    await expect(page.getByRole('status')).toHaveText('Reading history');
    await page.getByRole('button', { name: 'Remove work', exact: true }).click();
    await expect
      .poll(() =>
        viewport.evaluate((v) => {
          const content = v.firstElementChild!.firstElementChild as HTMLElement;
          const end = content.firstElementChild!.getBoundingClientRect().bottom;
          return {
            reserved: content.style.minHeight,
            visible: end > v.getBoundingClientRect().top,
          };
        })
      )
      .toEqual({ reserved: '', visible: true });
    await expect(page.getByRole('status')).toHaveText('Reading history');
    await page.getByRole('button', { name: 'Latest', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Following output');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  });

  test(`following a turn still folds its history and retains the final answer (${reducedMotion})`, async () => {
    await page.emulateMedia({ reducedMotion });
    await page.goto(
      `${server.resolvedUrls!.local[0]}tests/browser-fixtures/scroll-area.html?auto-fold&turn-group`
    );
    await page.getByRole('button', { name: 'Latest', exact: true }).click();
    await settle();
    await page.getByRole('button', { name: 'Finish run', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Turn work', exact: true })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    const viewport = page.locator('[data-radix-scroll-area-viewport]');
    await expect
      .poll(async () => {
        const v = (await viewport.boundingBox())!;
        const answer = (await page
          .getByText('Final verified result', { exact: true })
          .boundingBox())!;
        return answer.y >= v.y && answer.y + answer.height <= v.y + v.height;
      })
      .toBe(true);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  });
}

test('latest indicator measures visible bottom independently of disclosure reading mode', async () => {
  await openFixture();
  const latest = page.getByRole('button', { name: 'Return to latest', exact: true });
  await expect(latest).toHaveCount(0);
  const heading = page.locator('summary').filter({ hasText: /^View changed files$/ });
  await heading.click();
  await settle();
  await expect(page.getByRole('status')).toHaveText('Reading history');
  await expect(latest).toHaveCount(0);
  const viewport = page.locator('[data-radix-scroll-area-viewport]');
  const bounds = (await viewport.boundingBox())!;
  await page.mouse.move(bounds.x + 5, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, -500);
  await expect(latest).toBeVisible();
  await page.mouse.wheel(0, 5000);
  await expect(latest).toHaveCount(0);
});

test('latest indicator updates for viewport resizing and a completed return to bottom', async () => {
  await openFixture();
  const latest = page.getByRole('button', { name: 'Return to latest', exact: true });
  await page.locator('[data-radix-scroll-area-viewport]').hover();
  await page.mouse.wheel(0, -350);
  await expect(latest).toBeVisible();
  await page.getByRole('button', { name: 'Resize viewport', exact: true }).click();
  await expect(latest).toBeVisible();
  await latest.click();
  await expect(latest).toHaveCount(0);
  await page.getByRole('button', { name: 'Resize viewport', exact: true }).click();
  await settle();
  await expect(latest).toHaveCount(0);
});

async function settle() {
  // Include ResizeObserver, scroll events and React commits after the click.
  await page.waitForTimeout(400);
}

async function openFixture() {
  await page.goto(`${server.resolvedUrls!.local[0]}tests/browser-fixtures/scroll-area.html`);
  await page.getByText('Earlier conversation', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Latest', exact: true }).click();
  await settle();
}

async function openActivityFixture() {
  await page.goto(
    `${server.resolvedUrls!.local[0]}tests/browser-fixtures/scroll-area.html?activity`
  );
  await page.getByText('Earlier conversation', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Latest', exact: true }).click();
  await settle();
}

async function sampleToggle(heading: Locator, body: Locator) {
  const headingElement = (await heading.elementHandle())!;
  const before = (await headingElement.boundingBox())!;
  await body.evaluate((element) => {
    const samples: number[] = [];
    (window as unknown as { heights: number[] }).heights = samples;
    const start = window.performance.now();
    function sample() {
      samples.push(element.getBoundingClientRect().height);
      if (window.performance.now() - start < 500) requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  });
  await page.mouse.click(before.x + before.width / 2, before.y + before.height / 2);
  await page.waitForTimeout(550);
  const heights = await page.evaluate(() => (window as unknown as { heights: number[] }).heights);
  expect(new Set(heights.map(Math.round)).size).toBeGreaterThan(3);
  expect(Math.abs((await headingElement.boundingBox())!.y - before.y)).toBeLessThanOrEqual(2);
}

async function openSidebarFixture() {
  await page.goto(
    `${server.resolvedUrls!.local[0]}tests/browser-fixtures/scroll-area.html?sidebar`
  );
  await page.getByRole('separator', { name: 'Resize sidebar' }).waitFor();
  await settle();
}

test('sidebar project and Tasks disclosures animate both ways without shifting their triggers', async () => {
  await openSidebarFixture();
  for (const label of ['timeout', 'Tasks']) {
    const heading = page.getByRole('button', { name: label, exact: true });
    const body = page.locator(`[id="${await heading.getAttribute('aria-controls')}"]`);
    await sampleToggle(heading, body);
    await sampleToggle(heading, body);
  }
  await expect(page.getByText('Chat 5', { exact: true })).toBeVisible();
  const folder = (await page
    .getByRole('button', { name: 'timeout', exact: true })
    .locator('..')
    .boundingBox())!;
  const firstChat = (await page.getByText('Chat 1', { exact: true }).boundingBox())!;
  expect(folder.height).toBeLessThanOrEqual(30);
  expect(firstChat.y - folder.y - folder.height).toBeGreaterThanOrEqual(4);

  const projectToggle = page.getByRole('button', { name: 'timeout', exact: true });
  const projectActions = page.getByRole('button', { name: 'Project actions', exact: true });
  const chatArchive = page.getByRole('button', { name: 'Archive session', exact: true });
  await page.getByTestId('chat-canvas').hover();
  await expect(projectActions).toHaveCSS('opacity', '0');
  await expect(chatArchive.first()).toHaveCSS('opacity', '0');
  await projectToggle.hover();
  await expect(projectActions).toHaveCSS('opacity', '1');
  await expect(chatArchive.first()).toHaveCSS('opacity', '0');
  await page.getByText('Chat 1', { exact: true }).hover();
  await expect(chatArchive.first()).toHaveCSS('opacity', '1');
  await expect(chatArchive.nth(1)).toHaveCSS('opacity', '0');
  await expect(projectActions).toHaveCSS('opacity', '0');

  // The title and trailing blank area both toggle; editing must not toggle.
  const projectTitle = (await page.getByText('timeout', { exact: true }).boundingBox())!;
  await page.mouse.click(projectTitle.x + 10, projectTitle.y + projectTitle.height / 2);
  await expect(projectToggle).toHaveAttribute('aria-expanded', 'false');
  await settle();
  await projectToggle.click({ position: { x: (await projectToggle.boundingBox())!.width - 4, y: folder.height / 2 } });
  await expect(projectToggle).toHaveAttribute('aria-expanded', 'true');
  await settle();
  await projectActions.click();
  await page.getByRole('menuitem', { name: 'Rename project' }).click();
  const projectInput = page.getByRole('textbox', { name: 'Project name' });
  await projectInput.click();
  await expect(projectToggle).toHaveAttribute('aria-expanded', 'true');
  await projectInput.press('Escape');
  await expect(projectInput).toHaveCount(0);
  await projectToggle.focus();
  await page.keyboard.press('Enter');
  await expect(projectToggle).toHaveAttribute('aria-expanded', 'false');
});

test('sidebar follows drag, keeps its saved width across reopen and reload, and supports keyboard limits', async () => {
  await openSidebarFixture();
  const separator = page.getByRole('separator', { name: 'Resize sidebar' });
  await separator.dblclick();
  await settle();
  const sidebar = page.locator('aside');
  const initial = (await sidebar.boundingBox())!.width;
  const handle = (await separator.boundingBox())!;
  const border = (await sidebar.locator(':scope > div > div').boundingBox())!;
  const line = (await separator.locator('span').boundingBox())!;
  expect(Math.abs(line.x - (border.x + border.width - 1))).toBeLessThanOrEqual(1);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 120);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 96, handle.y + 120, { steps: 8 });
  await page.waitForTimeout(50);
  expect((await sidebar.boundingBox())!.width).toBeCloseTo(initial + 96, 0);
  await page.mouse.up();
  await page.getByRole('button', { name: 'Toggle sidebar' }).click();
  await settle();
  expect((await sidebar.boundingBox())!.width).toBe(0);
  await expect(separator).toHaveCount(0);
  await page.getByRole('button', { name: 'Toggle sidebar' }).click();
  await settle();
  expect((await sidebar.boundingBox())!.width).toBeCloseTo(initial + 96, 0);
  await page.reload();
  await separator.waitFor();
  await settle();
  expect((await sidebar.boundingBox())!.width).toBeCloseTo(initial + 96, 0);
  await separator.focus();
  await page.keyboard.press('ArrowLeft');
  await settle();
  expect((await sidebar.boundingBox())!.width).toBeCloseTo(initial + 80, 0);
  for (let i = 0; i < 20; i += 1) await page.keyboard.press('ArrowRight');
  await settle();
  expect((await sidebar.boundingBox())!.width).toBe(420);
  await page.setViewportSize({ width: 700, height: 760 });
  await settle();
  expect((await sidebar.boundingBox())!.width).toBe(340);
  expect((await page.getByTestId('chat-canvas').boundingBox())!.width).toBeGreaterThanOrEqual(360);
  await page.setViewportSize({ width: 1000, height: 760 });
  await separator.focus();
  await page.keyboard.press('Home');
  await settle();
  expect((await sidebar.boundingBox())!.width).toBe(initial);
});

test('sidebar drag can collapse completely, reverse before release, and restore the prior width', async () => {
  await openSidebarFixture();
  const sidebar = page.locator('aside');
  const separator = page.getByRole('separator', { name: 'Resize sidebar' });
  await separator.dblclick();
  await settle();
  const initial = (await sidebar.boundingBox())!.width;
  const handle = (await separator.boundingBox())!;
  const x = handle.x + handle.width / 2;
  const y = handle.y + 100;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - initial + 60, y, { steps: 8 });
  await expect(sidebar).toHaveCSS('width', '0px');
  // Pointer capture survives a zero-width preview, so reversing remains possible.
  await page.mouse.move(x, y, { steps: 8 });
  await expect(sidebar).toHaveCSS('width', `${initial}px`);
  await page.mouse.move(x - initial + 60, y, { steps: 8 });
  await page.mouse.up();
  await settle();
  await expect(sidebar).toHaveCSS('width', '0px');
  await expect(sidebar).toHaveAttribute('inert', '');
  expect(await page.evaluate(() => localStorage.getItem('navigation_width'))).toBe(String(initial));
  await page.getByRole('button', { name: 'Toggle sidebar' }).click();
  await settle();
  await expect(sidebar).toHaveCSS('width', `${initial}px`);
  await expect(page.getByRole('button', { name: 'CodeBuddy' })).toBeVisible();
  await separator.focus();
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowLeft');
  await settle();
  await expect(sidebar).toHaveCSS('width', '0px');
});

test('conversation presentation contains rounded disclosure backgrounds and preserves text hierarchy', async () => {
  await page.goto(
    `${server.resolvedUrls!.local[0]}tests/browser-fixtures/scroll-area.html?presentation`
  );
  const prose = page.getByText('收到需求，开始处理。', { exact: true });
  const heading = page.getByRole('heading', { name: '实现结果' });
  const duration = page.getByRole('button', { name: '用时 1分钟 10秒' });
  const thinking = page.getByRole('button', { name: 'Thinking', exact: true });
  const files = page.getByRole('button', { name: '列出文件' });
  await prose.waitFor();
  const left = (await prose.boundingBox())!.x;
  for (const trigger of [duration, thinking, files]) {
    const label = trigger.locator(':scope > span:not([aria-hidden])').first();
    const text = (await label.boundingBox())!;
    const arrow = (await trigger.locator(':scope > svg').boundingBox())!;
    expect(Math.abs(text.x - left - (trigger === files ? 24 : 0))).toBeLessThanOrEqual(1);
    expect(arrow.x - text.x - text.width).toBeGreaterThanOrEqual(4);
    expect(arrow.x - text.x - text.width).toBeLessThanOrEqual(10);
    await expect(label).toHaveCSS('font-size', '12.5px');
    await expect(trigger).toHaveCSS('border-radius', '10px');
  }
  expect(
    Math.abs(left - (await page.locator('.codepro-chat-history').boundingBox())!.x)
  ).toBeLessThanOrEqual(1);
  await duration.click();
  const record = page.getByText('处理记录', { exact: true });
  await expect(record).toHaveCSS('font-size', '13.5px');
  expect(Math.abs((await record.boundingBox())!.x - left)).toBeLessThanOrEqual(1);
  await expect(page.getByText('操作说明', { exact: true })).toHaveCSS('font-size', '12.5px');
  const historyBody = page.locator(`[id="${await duration.getAttribute('aria-controls')}"]`);
  const nestedFile = page.getByRole('button', { name: '已查看文件 smoke_test_app.py' });
  const activity = page.getByRole('button', {
    name: 'Operations recorded 2 actions',
    exact: true,
  });
  for (const row of [nestedFile, activity]) {
    await row.hover();
    await expect(row).toHaveCSS('border-radius', '10px');
    await expect(row).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const rowBox = (await row.boundingBox())!;
    const clipBox = (await historyBody.boundingBox())!;
    expect(rowBox.x).toBeGreaterThanOrEqual(clipBox.x);
    expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(clipBox.x + clipBox.width + 1);
    const iconBox = (await row.locator(':scope > span[aria-hidden]').boundingBox())!;
    expect(iconBox.x - rowBox.x).toBeGreaterThanOrEqual(row === nestedFile ? 0 : 8);
  }

  const plan = page.getByTestId('work-plan').locator('summary');
  await plan.hover();
  const planBox = (await plan.boundingBox())!;
  const planIcon = (await plan.locator('.lucide-list-checks').boundingBox())!;
  expect(planIcon.x - planBox.x).toBeGreaterThanOrEqual(8);
  expect(planBox.x + planBox.width - planIcon.x - planIcon.width).toBeGreaterThan(8);
  await expect(plan.locator('.lucide-list-checks')).toBeVisible();
  await expect(prose).toHaveCSS('font-size', '13.5px');
  await expect(heading).toHaveCSS('font-size', '15px');
  await expect(heading).toHaveCSS('font-weight', '600');
  await expect(files.locator('.codepro-record-icon svg')).toBeVisible();
  const filesBox = (await files.boundingBox())!;
  const fileIcon = (await files.locator('.codepro-record-icon').boundingBox())!;
  expect(fileIcon.x - filesBox.x).toBeGreaterThanOrEqual(0);
  await files.click();
  const summary = page.locator('summary').filter({ hasText: '诊断记录' });
  await expect(summary).toHaveCSS('list-style-type', 'none');
  expect(await summary.evaluate((el) => window.getComputedStyle(el, '::after').content)).toBe('""');
  await summary.click();
  await expect(page.getByText('原始回执')).toBeVisible();
  await page.getByRole('button', { name: 'change.py', exact: true }).click();
  const added = page.locator('[data-diff-kind="added"]');
  const removed = page.locator('[data-diff-kind="removed"]');
  await expect(added.locator(':scope > span').first()).toHaveText('7');
  await expect(removed.locator(':scope > span').first()).toHaveText('7');
  const addedStyle = await added.evaluate((el) => ({
    color: window.getComputedStyle(el).color,
    background: window.getComputedStyle(el).backgroundColor,
  }));
  const removedStyle = await removed.evaluate((el) => ({
    color: window.getComputedStyle(el).color,
    background: window.getComputedStyle(el).backgroundColor,
  }));
  expect(addedStyle.color).toBe(removedStyle.color);
  expect(addedStyle.background).not.toBe(removedStyle.background);
  expect(addedStyle.background).not.toBe('rgba(0, 0, 0, 0)');
});

test('conversation font family and fractional layout match in main and subagent contexts while code stays monospace', async () => {
  const results: {
    context: string;
    size: number;
    fontSize: string;
    lineHeight: string;
    fontFamily: string;
    height: number;
    devicePixelRatio: number;
  }[] = [];
  for (const context of ['main', 'subagent']) {
    await page.goto(
      `${server.resolvedUrls!.local[0]}tests/browser-fixtures/scroll-area.html?presentation${context === 'subagent' ? '&subagent' : ''}`
    );
    const prose = page.getByText('收到需求，开始处理。', { exact: true });
    await expect(prose).toHaveCSS('font-size', '13.5px');
    await expect(page.getByRole('heading', { name: '实现结果' })).toHaveCSS('font-size', '15px');
    const family = await prose.evaluate((element) => window.getComputedStyle(element).fontFamily);
    expect(
      family
        .split(',')
        .slice(0, 2)
        .map((part) => part.trim().replaceAll('"', ''))
    ).toEqual(['Noto Sans SC', 'Noto Sans CJK SC']);
    expect(family).toContain('system-ui');
    const content = page.locator('.codepro-assistant-prose').first();
    for (const node of await content.locator('p, h2, ul, li').all()) {
      await expect(node).toHaveCSS('font-family', family);
    }
    const codeFamilies = await content
      .locator('code, pre')
      .evaluateAll((elements) =>
        elements.map((element) => window.getComputedStyle(element).fontFamily)
      );
    expect(codeFamilies.length).toBeGreaterThanOrEqual(2);
    for (const codeFamily of codeFamilies) {
      expect(codeFamily).toContain('monospace');
      expect(codeFamily).not.toContain('Noto Sans SC');
    }
    const bodyFamily = await page
      .locator('body')
      .evaluate((element) => window.getComputedStyle(element).fontFamily);
    expect(bodyFamily).not.toContain('Noto Sans SC');
    let previousHeight = 0;
    for (const size of [13, 13.5, 14]) {
      await page.locator('.codepro-chat-history').evaluate((element, value) => {
        (element as HTMLElement).style.setProperty('--conversation-text-size', `${value}px`);
      }, size);
      await expect(prose).toHaveCSS('font-size', `${size}px`);
      const computed = await prose.evaluate((element) => {
        const style = window.getComputedStyle(element);
        return {
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          fontFamily: style.fontFamily,
          height: element.getBoundingClientRect().height,
          devicePixelRatio: window.devicePixelRatio,
        };
      });
      expect(Number.parseFloat(computed.lineHeight)).toBeCloseTo(size * 1.65, 2);
      // Layout keeps subpixels; actual glyph rasterization is verified separately on Windows.
      expect(computed.height).toBeGreaterThan(previousHeight);
      previousHeight = computed.height;
      results.push({ context, size, ...computed });
      await page.screenshot({
        path: test.info().outputPath(`conversation-${context}-${size}px.png`),
        fullPage: true,
      });
    }
  }
  for (const size of [13, 13.5, 14]) {
    const main = results.find((item) => item.context === 'main' && item.size === size)!;
    const child = results.find((item) => item.context === 'subagent' && item.size === size)!;
    expect(child.fontSize).toBe(main.fontSize);
    expect(child.lineHeight).toBe(main.lineHeight);
    expect(child.fontFamily).toBe(main.fontFamily);
  }
  const computedPath = test.info().outputPath('conversation-font-computed.json');
  await writeFile(computedPath, JSON.stringify(results, null, 2));
  await test.info().attach('conversation-font-computed', {
    path: computedPath,
    contentType: 'application/json',
  });
});

test('healthy extension startup stays quiet while a new failure remains actionable', async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}tests/browser-fixtures/scroll-area.html?toast`);
  await page.getByRole('button', { name: 'Finish extensions' }).click();
  const notification = page.getByRole('alert');
  await expect(notification).toHaveCount(0);
  await page.getByRole('button', { name: 'Fail extension' }).click();
  await expect(notification).toContainText('1 extension failed to load');
  await notification.hover();
  await page.waitForTimeout(5200);
  await expect(notification).toBeVisible();
  await page.getByRole('button', { name: 'Finish extensions' }).hover();
  await expect(notification).toHaveCount(0, { timeout: 6500 });
});

test('extension loading remains truthful until settled and an updated failure also expires', async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}tests/browser-fixtures/scroll-area.html?toast`);
  await page.getByRole('button', { name: 'Start extensions' }).click();
  const notification = page.getByRole('alert');
  await page.waitForTimeout(5400);
  await expect(notification).toContainText('Loading 1 extension');
  await page.getByRole('button', { name: 'Fail extension' }).click();
  await expect(notification).toContainText('1 extension failed to load');
  await expect(notification).toHaveCount(0, { timeout: 6500 });
});

test('actual recorded-operations group and nested operation both animate when closed and reopened', async () => {
  await openActivityFixture();
  const group = page.getByRole('button', { name: 'Operations recorded 2 actions', exact: true });
  const groupBody = page.locator(`[id="${await group.getAttribute('aria-controls')}"]`);
  await sampleToggle(group, groupBody);
  const operation = page.getByRole('button', { name: /Activity:.*README.md/ });
  const operationBody = page.locator(`[id="${await operation.getAttribute('aria-controls')}"]`);
  await sampleToggle(operation, operationBody);
  await sampleToggle(operation, operationBody);
  await sampleToggle(group, groupBody);
  await sampleToggle(group, groupBody);
});

test('technical text keeps a three-line preview and animates to the full original value', async () => {
  await openActivityFixture();
  const heading = page.getByRole('button', { name: 'Expand Long output', exact: true });
  const body = page.locator(`[id="${await heading.getAttribute('aria-controls')}"]`);
  const before = (await body.boundingBox())!.height;
  expect(before).toBeLessThan(70);
  await sampleToggle(heading, body);
  expect((await body.boundingBox())!.height).toBeGreaterThan(before * 3);
  await sampleToggle(page.getByRole('button', { name: 'Collapse Long output', exact: true }), body);
  expect((await body.boundingBox())!.height).toBe(before);
});

test('compact work plan remains visible above its trigger and fades during closing', async () => {
  await openActivityFixture();
  const heading = page.locator('[data-testid="work-plan"] summary');
  await heading.click();
  await settle();
  const plan = page.getByText('First step', { exact: true });
  await expect(plan).toBeVisible();
  expect((await plan.boundingBox())!.y).toBeLessThan((await heading.boundingBox())!.y);
  await heading.click();
  await settle();
  await expect(plan).toBeHidden();
});

test('native file disclosure keeps its click position through repeated collapse and expansion', async () => {
  await openFixture();
  const heading = page.locator('summary').filter({ hasText: /^View changed files$/ });
  const original = (await heading.boundingBox())!;
  for (let i = 0; i < 4; i += 1) {
    // Deliberately reuse the same pointer position: users should not chase the header.
    await page.mouse.click(original.x + 30, original.y + original.height / 2);
    await settle();
    const current = (await heading.boundingBox())!;
    expect(Math.abs(current.y - original.y)).toBeLessThanOrEqual(2);
    expect(await heading.evaluate((el) => (el.parentElement as HTMLDetailsElement).open)).toBe(
      i % 2 !== 0
    );
  }
});

test('file disclosure has intermediate heights without moving its header during the transition', async () => {
  await openFixture();
  const heading = page.locator('summary').filter({ hasText: /^View changed files$/ });
  const before = (await heading.boundingBox())!;
  await heading.evaluate((element) => {
    const samples: { top: number; height: number }[] = [];
    (window as unknown as { foldSamples: typeof samples }).foldSamples = samples;
    const start = window.performance.now();
    function sample() {
      samples.push({
        top: element.getBoundingClientRect().top,
        height: element.parentElement!.getBoundingClientRect().height,
      });
      if (window.performance.now() - start < 500) requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  });
  await page.mouse.click(before.x + 30, before.y + before.height / 2);
  await page.waitForTimeout(550);
  const samples = await page.evaluate(
    () => (window as unknown as { foldSamples: { top: number; height: number }[] }).foldSamples
  );
  expect(Math.max(...samples.map((sample) => Math.abs(sample.top - before.y)))).toBeLessThanOrEqual(
    2
  );
  const heights = new Set(samples.map((sample) => Math.round(sample.height)));
  expect(heights.size).toBeGreaterThan(3);
});

test('React disclosure stays anchored for keyboard toggles and respects reduced motion', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  try {
    await openFixture();
    const heading = page.getByRole('button', { name: 'Work history', exact: true });
    await heading.scrollIntoViewIfNeeded();
    await heading.focus();
    const before = (await heading.boundingBox())!;
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press('Space');
      await settle();
      expect(Math.abs((await heading.boundingBox())!.y - before.y)).toBeLessThanOrEqual(2);
      expect(await heading.getAttribute('aria-expanded')).toBe(String(i % 2 !== 0));
    }
    expect(
      await page
        .locator('.codepro-disclosure-content')
        .first()
        .evaluate((el) => window.getComputedStyle(el).animationName)
    ).toBe('none');
  } finally {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  }
});

test('manual reading survives new output and Latest releases the reserved space and resumes following', async () => {
  await openFixture();
  const heading = page.locator('summary').filter({ hasText: /^View changed files$/ });
  await heading.click();
  await settle();
  const before = (await heading.boundingBox())!;
  await page.getByRole('button', { name: 'Append output', exact: true }).click();
  await settle();
  expect(Math.abs((await heading.boundingBox())!.y - before.y)).toBeLessThanOrEqual(2);

  await page.getByRole('button', { name: 'Latest', exact: true }).click();
  await settle();
  await page.getByRole('button', { name: 'Append output', exact: true }).click();
  await settle();
  const viewport = page.locator('[data-radix-scroll-area-viewport]');
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight), {
      timeout: 2000,
    })
    .toBeLessThanOrEqual(2);

  const box = (await viewport.boundingBox())!;
  await page.mouse.move(box.x + box.width - 30, box.y + 100);
  await page.mouse.wheel(0, -100);
  await settle();
  const readingTop = await viewport.evaluate((el) => el.scrollTop);
  await page.getByRole('button', { name: 'Append output', exact: true }).click();
  await settle();
  expect(await viewport.evaluate((el) => el.scrollTop)).toBe(readingTop);
});

test('scrolling down during a burst keeps following after the gesture ends', async () => {
  await openFixture();
  const viewport = page.locator('[data-radix-scroll-area-viewport]');
  await page.getByRole('button', { name: 'Append burst', exact: true }).click();
  const box = (await viewport.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 40);
  await expect(page.getByRole('status')).toHaveText('Following output');
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight), {
      timeout: 5000,
    })
    .toBeLessThanOrEqual(2);
});

test('layout growth keeps following and manual return to the bottom resumes it', async () => {
  await openFixture();
  const viewport = page.locator('[data-radix-scroll-area-viewport]');
  await page.getByRole('button', { name: 'Grow earlier content', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Following output');
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight), {
      timeout: 5000,
    })
    .toBeLessThanOrEqual(2);
  const box = (await viewport.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -300);
  await expect(page.getByRole('status')).toHaveText('Reading history');
  await page.mouse.wheel(0, 2000);
  await expect(page.getByRole('status')).toHaveText('Following output');
  await page.getByRole('button', { name: 'Append output', exact: true }).click();
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight), {
      timeout: 3000,
    })
    .toBeLessThanOrEqual(2);
});

test('file-card disclosures preserve counts and motion while opening saved diffs in one workspace tab', async () => {
  await page.goto(
    `${server.resolvedUrls!.local[0]}tests/browser-fixtures/scroll-area.html?file-card`
  );
  const card = page.getByRole('button', { name: 'Modified 2 files this turn', exact: true });
  await expect(card).toBeVisible();
  await expect(card).toContainText('+90');
  await expect(card).toContainText('−90');
  await page.getByRole('button', { name: 'Latest', exact: true }).click();
  await settle();
  await expect(card).toHaveAttribute('aria-expanded', 'true');
  const cardBody = page.locator(`[id="${await card.getAttribute('aria-controls')}"]`);
  await sampleToggle(card, cardBody);
  await expect(card).toHaveAttribute('aria-expanded', 'false');
  await sampleToggle(card, cardBody);
  await expect(card).toHaveAttribute('aria-expanded', 'true');
  const file = page.getByRole('button', { name: 'app.py', exact: true });
  await expect(file).toContainText('+60');
  await expect(file).toContainText('−60');
  await expect(file).not.toHaveAttribute('aria-expanded');
  await expect(file).not.toHaveAttribute('aria-controls');
  const inlineHeight = (await cardBody.boundingBox())!.height;
  await file.click();
  const panel = page.getByRole('complementary', { name: 'Workspace', exact: true });
  const tab = panel.getByRole('tab', { name: 'Turn 1 · app.py', exact: true });
  await expect(tab).toBeVisible();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByText(/^Edit 1\s*\+30\s*−30$/)).toBeVisible();
  await expect(panel.getByText(/^Edit 2\s*\+30\s*−30$/)).toBeVisible();
  await expect(panel.locator('[data-diff-kind="removed"]')).toHaveCount(60);
  await expect(panel.locator('[data-diff-kind="added"]')).toHaveCount(60);
  await expect(panel.locator('[data-diff-kind="removed"]').first()).toContainText('before 0');
  await expect(panel.locator('[data-diff-kind="added"]').first()).toContainText('after 0');
  await expect(page.locator('.codepro-chat-history [data-diff-kind]')).toHaveCount(0);
  expect(Math.abs((await cardBody.boundingBox())!.height - inlineHeight)).toBeLessThanOrEqual(1);
  await file.click();
  await expect(tab).toHaveCount(1);
  await panel.getByRole('tab', { name: 'Changes', exact: true }).click();
  await file.click();
  await expect(tab).toHaveCount(1);
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await sampleToggle(card, cardBody);
  await sampleToggle(card, cardBody);
  await expect(file).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('file-card-workspace-saved-diff.png'),
    fullPage: true,
  });
});
