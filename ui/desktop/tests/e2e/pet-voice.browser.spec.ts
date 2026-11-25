import { chromium, expect, test } from '@playwright/test';
import { createServer } from 'vite';
import { resolve } from 'node:path';

test('pet voice notices fit the narrow composer and support keyboard retry and dismissal', async () => {
  test.setTimeout(120000);
  const server = await createServer({
    configFile: resolve('vite.renderer.config.mts'), server: { host: '127.0.0.1', port: 0, hmr: false },
    plugins: [{ name: 'voice-ui-fixture', enforce: 'pre', resolveId(source, importer) {
      if (source === '../hooks/useAudioRecorder' && importer?.includes('/src/pets/DesktopPet.tsx'))
        return resolve('tests/browser-fixtures/voice-recorder.ts');
    } }],
  });
  const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome' });
  try {
    await server.listen();
    const page = await browser.newPage({ viewport: { width: 340, height: 520 }, locale: 'zh-CN' });
    for (const notice of ['silent', 'empty']) {
      await page.goto(server.resolvedUrls!.local[0] + `tests/browser-fixtures/pet-voice.html?notice=${notice}`);
      await page.getByRole('button', { name: '点击宠物发消息' }).press('Enter');
      const mic = page.getByRole('button', { name: '按住说话', exact: true });
      await mic.focus();
      await page.keyboard.down('Space');
      await expect(page.getByRole('status')).toContainText('正在录音');
      await page.keyboard.up('Space');
      await expect(page.getByRole('status')).toContainText(notice === 'silent' ? '未检测到清晰语音' : '未识别到文字');
      await expect(page.getByRole('textbox')).toHaveValue('');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`${notice}.png`) });
      await page.getByRole('button', { name: '重试', exact: true }).click();
      await expect(mic).toBeFocused();
      await expect(page.getByRole('status')).toHaveCount(0);
      await page.keyboard.down('Space');
      await expect(page.getByRole('status')).toContainText('正在录音');
      await page.keyboard.up('Space');
      await page.getByRole('button', { name: '关闭语音提示' }).click();
      await expect(page.getByRole('status')).toHaveCount(0);
    }
  } finally { await browser.close(); await server.close(); }
});
