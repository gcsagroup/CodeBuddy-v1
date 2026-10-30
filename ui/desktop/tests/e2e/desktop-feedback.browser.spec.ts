import { chromium, expect, test } from '@playwright/test';
import { desktopFeedbackDocument } from '../../src/desktopFeedbackDocument';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

test('feedback remains readable, bounded and click-through at desktop and narrow sizes', async () => {
  const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
  const output = resolve('../../.local/desktop-feedback-design-20261030');
  await mkdir(output, { recursive: true });
  try {
    const page = await browser.newPage();
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ['light', 'dark']) {
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.setContent(desktopFeedbackDocument('Esc 停止电脑控制') + `<style>
          html{background:${theme === 'light' ? '#f4f6fa' : '#121824'}}
          .workspace{position:absolute;inset:100px 7%;z-index:-1;font:16px "Segoe UI",sans-serif;color:${theme === 'light' ? '#52627a' : '#a9b8cd'}}
          h1{font-size:30px;font-weight:600;color:inherit}.panel{height:180px;border:1px solid #8a9ab433;border-radius:18px;padding:24px;margin-top:28px}
          #pointer{display:block;transform:translate3d(${width / 2}px,360px,0)}
          </style><main class="workspace"><h1>CodeBuddy</h1><p>电脑控制 · 视觉验收</p><div class="panel">内容区域保持清晰<br><br>控制提示固定在屏幕顶部</div></main>`);
        const banner = page.locator('.banner');
        await expect(banner).toBeVisible();
        const box = await banner.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        expect(await banner.evaluate(el => getComputedStyle(el).pointerEvents)).toBe('none');
        expect(await page.locator('.glow').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
        const glow = page.locator('.glow');
        expect(await glow.evaluate(el => getComputedStyle(el).animationName)).toBe('edge-breathe');
        expect(box!.height).toBeLessThanOrEqual(40);
        const sheen = () => banner.evaluate(el => getComputedStyle(el, '::before').transform);
        const firstFrame = await sheen();
        await expect.poll(sheen).not.toBe(firstFrame);
        const status = page.locator('.status');
        const textPosition = () => page.locator('.status-shine').evaluate(el => getComputedStyle(el, '::before').transform);
        const firstTextFrame = await textPosition();
        await expect.poll(textPosition).not.toBe(firstTextFrame);
        if (width === 1440 && theme === 'light') {
          await banner.screenshot({ path: resolve(output, 'banner-animated.png') });
        }
        for (const hint of ['Esc 停止电脑控制', '在对话中停止电脑控制']) {
          // The host updates this text when the Escape listener becomes ready.
          await page.locator('.hint').evaluate((el, hint) => { el.textContent = hint; }, hint);
          const hintBox = await page.locator('.hint').boundingBox();
          const currentBox = await banner.boundingBox();
          expect(hintBox!.x + hintBox!.width).toBeLessThanOrEqual(currentBox!.x + currentBox!.width);
          expect(await page.locator('.hint').evaluate(el => getComputedStyle(el).pointerEvents)).toBe('none');
        }
        await page.emulateMedia({ reducedMotion: 'reduce' });
        expect(await banner.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
        expect(await glow.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
        expect(await banner.evaluate(el => getComputedStyle(el, '::before').animationName)).toBe('none');
        expect(await page.locator('.mark').evaluate(el => getComputedStyle(el, '::after').animationName)).toBe('none');
        expect(await status.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
        expect(await status.evaluate(el => getComputedStyle(el).color)).toBe('rgb(213, 229, 255)');
        await page.screenshot({ path: resolve(output, `${theme}-${width}.png`) });
      }
    }
  } finally { await browser.close(); }
});
