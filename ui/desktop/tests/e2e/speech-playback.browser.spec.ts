import { chromium, expect, test } from '@playwright/test';
import { createServer } from 'vite';
import { createServer as httpServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('reply playback is explicit, streams real audio, switches and stops; TTS settings check works', async () => {
  test.skip(process.env.SPEECH_LIVE_TEST !== '1', 'Explicit live TTS test required');
  test.setTimeout(120000);
  const { createSpeechPlaybackServer } = await import('../../../../runtime/speech-playback.mjs');
  const settings = {
    REMOTE_TTS_URL: 'http://192.168.50.231:18004/v1/audio/speech',
    REMOTE_TTS_MODEL: 'Qwen3-TTS-12Hz-0.6B-Base-INT4',
  };
  const calls = createSpeechPlaybackServer({
    read: () => ({ config: { SPEECH_SERVICES: { value: settings } } }),
  });
  let connections = 0;
  const transport = httpServer();
  transport.on('upgrade', (req, socket, head) => {
    connections++;
    calls.handleUpgrade(req, socket, head, (ws) => calls.emit('connection', ws));
  });
  await new Promise<void>((done) => transport.listen(0, '127.0.0.1', done));
  const url = `ws://127.0.0.1:${(transport.address() as { port: number }).port}/acp`;
  const cache = await mkdtemp(join(tmpdir(), 'speech-playback-'));
  const vite = await createServer({
    configFile: resolve('vite.renderer.config.mts'),
    cacheDir: cache,
    optimizeDeps: { entries: ['tests/browser-fixtures/speech-playback.html'] },
    plugins: [
      {
        name: 'speech-fixture',
        enforce: 'pre',
        resolveId(source, importer) {
          if (importer?.replaceAll('\\', '/').endsWith('/SpeechSettings.tsx')) {
            if (source.endsWith('/acp/config')) return '\0speech-config';
            if (source.endsWith('/acp/dictation')) return '\0speech-dictation';
          }
        },
        load(id) {
          if (id === '\0speech-config')
            return `let values=${JSON.stringify(settings)};export async function acpReadConfig(){return values} export async function acpUpsertConfig(_key,value){values=value}`;
          if (id === '\0speech-dictation') return 'export async function checkDictationService(){}';
        },
      },
    ],
    server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  const browser = await chromium.launch({
    channel: process.platform === 'win32' ? 'msedge' : undefined,
  });
  try {
    await vite.listen();
    const page = await browser.newPage({ viewport: { width: 1080, height: 1500 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(
      ({ url }) => {
        Object.assign(window, {
          electron: { getAcpUrl: async () => url },
          appConfig: { get: () => undefined },
        });
        const probe = { clicked: 0, started: 0, first: 0, energy: 0, samples: 0 };
        document.addEventListener(
          'click',
          (event) => {
            if (
              (event.target as Element)?.closest('button')?.getAttribute('aria-label') ===
              '语音播报'
            )
              probe.clicked = performance.now();
          },
          true
        );
        Object.assign(window, { speechProbe: probe });
        const send = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
          if (typeof data === 'string' && JSON.parse(data).type === 'start') {
            probe.started = performance.now();
            probe.first = 0;
          }
          return send.call(this, data);
        };
        const create = AudioContext.prototype.createBufferSource;
        AudioContext.prototype.createBufferSource = function () {
          const source = create.call(this),
            start = source.start.bind(source),
            context = this;
          source.start = (when = 0) => {
            const samples = source.buffer?.getChannelData(0);
            if (samples) {
              probe.samples += samples.length;
              for (const sample of samples) probe.energy += sample * sample;
            }
            probe.first ||= performance.now() + Math.max(0, when - context.currentTime) * 1000;
            start(when);
          };
          return source;
        };
      },
      { url }
    );
    await page.goto(vite.resolvedUrls!.local[0] + 'tests/browser-fixtures/speech-playback.html');
    await expect(page.getByTestId('first').getByRole('button', { name: '语音播报' })).toBeVisible();
    expect(connections).toBe(0);
    const first = page.getByTestId('first'),
      second = page.getByTestId('second');
    await first.getByRole('button', { name: '语音播报' }).click();
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (window as unknown as { speechProbe: { energy: number } }).speechProbe.energy
          ),
        { timeout: 30000 }
      )
      .toBeGreaterThan(0);
    console.log(
      'SPEECH_PLAYBACK',
      await page.evaluate(() => {
        const p = (
          window as unknown as {
            speechProbe: { clicked: number; first: number; started: number; energy: number };
          }
        ).speechProbe;
        return {
          clickToScheduledAudioMs: p.first - p.clicked,
          requestToScheduledAudioMs: p.first - p.started,
          energy: p.energy,
        };
      })
    );
    await expect(first.getByRole('button', { name: '语音播报' })).toBeVisible({ timeout: 40000 });
    for (let round = 0; round < 3; round++) {
      await first.getByRole('button', { name: '语音播报' }).click();
      await expect(first.getByRole('button', { name: '停止播报' })).toBeVisible({ timeout: 30000 });
      await second.getByRole('button', { name: '语音播报' }).click();
      await expect(first.getByRole('button', { name: '语音播报' })).toBeVisible();
      await expect(second.getByRole('button', { name: '停止播报' })).toBeVisible({
        timeout: 30000,
      });
      expect(await page.getByRole('alert').count()).toBe(0);
      await second.getByRole('button', { name: '停止播报' }).click();
      await expect(second.getByRole('button', { name: '语音播报' })).toBeVisible();
    }
    const form = page.getByRole('form', { name: 'Synthesis service' });
    await form.getByRole('button', { name: '保存并检测' }).click();
    await expect(form.getByRole('status')).toContainText('连接正常', { timeout: 30000 });
    settings.REMOTE_TTS_URL = 'http://127.0.0.1:1/v1/audio/speech';
    await first.getByRole('button', { name: '语音播报' }).click();
    await expect(page.locator('.model-connection-center').getByRole('alert')).toContainText(
      '语音播报失败'
    );
    expect(await first.getByRole('alert').count()).toBe(0);
    await page.screenshot({ path: 'test-results/speech-playback.png', fullPage: true });
    await page.getByRole('button', { name: '关闭播报错误通知' }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await vite.close();
    for (const ws of calls.clients) ws.terminate();
    calls.close();
    await new Promise<void>((done) => transport.close(() => done()));
    await rm(cache, { recursive: true, force: true });
  }
});
