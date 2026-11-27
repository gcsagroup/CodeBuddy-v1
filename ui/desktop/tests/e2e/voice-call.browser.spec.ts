import { chromium, expect, test } from '@playwright/test';
import { createServer } from 'vite';
import { createServer as httpServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('Gemma native audio to streaming TTS works in the phone page', async () => {
  test.skip(
    process.env.VOICE_LIVE_TEST !== '1' || !process.env.VOICE_TEST_AUDIO,
    'Explicit live service and spoken WAV fixture required'
  );
  test.setTimeout(120000);
  const persona = process.env.VOICE_TEST_PERSONA
    ? JSON.parse(await readFile(process.env.VOICE_TEST_PERSONA, 'utf8'))
    : { name: '测试助手', prompt: '你是一位友好的中文聊天伙伴。' };
  const { createVoiceCallServer } = await import('../../../../runtime/voice-call.mjs');
  const calls = createVoiceCallServer();
  const transport = httpServer();
  transport.on('upgrade', (req, socket, head) =>
    calls.handleUpgrade(req, socket, head, (ws) => calls.emit('connection', ws))
  );
  await new Promise<void>((done) => transport.listen(0, '127.0.0.1', done));
  const url = `ws://127.0.0.1:${(transport.address() as { port: number }).port}/acp`;
  const cache = await mkdtemp(join(tmpdir(), 'voice-pipeline-'));
  const vite = await createServer({
    configFile: resolve('vite.renderer.config.mts'),
    cacheDir: cache,
    optimizeDeps: { entries: ['tests/browser-fixtures/voice-call.html'] },
    plugins: [
      {
        name: 'voice-test',
        enforce: 'pre',
        configureServer(server) {
          server.middlewares.use((req, _res, next) => {
            if (req.url === '/voice-call-test.html') req.url = '/tests/browser-fixtures/voice-call.html';
            next();
          });
        },
        resolveId(source, importer) {
          if (importer?.replaceAll('\\', '/').endsWith('/WorkspaceVoiceCall.tsx')) {
            if (source.endsWith('/agentApi')) return '\0voice-agent';
            if (source === './WorkspaceGeneration') return '\0voice-text';
          }
        },
        load(id) {
          if (id === '\0voice-text') return 'export const mediaText = (en, cn) => cn;';
          if (id === '\0voice-agent')
            return `const profile = ${JSON.stringify({ ...persona, id: 'test', avatar: '🌸' })}; export async function agentRequest(action) { return action === 'list' ? { profiles: [profile] } : { selection: { profile } }; }`;
        },
      },
    ],
    server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  const browser = await chromium.launch({
    channel: process.platform === 'win32' ? 'msedge' : undefined,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      `--use-file-for-fake-audio-capture=${process.env.VOICE_TEST_AUDIO}`,
    ],
  });
  try {
    await vite.listen();
    const page = await browser.newPage({ viewport: { width: 600, height: 850 } });
    await page.addInitScript(
      ({ url }) => {
        Object.assign(window, {
          electron: { getAcpUrl: async () => url },
          appConfig: { get: () => undefined },
        });
        const probe = {
          sentAt: 0,
          playedAt: 0,
          samples: 0,
          energy: 0,
          tracks: [] as MediaStreamTrack[],
        };
        Object.assign(window, { voiceProbe: probe });
        const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          const stream = await gum(constraints);
          probe.tracks.push(...stream.getTracks());
          return stream;
        };
        const send = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
          if (data instanceof ArrayBuffer) probe.sentAt = performance.now();
          return send.call(this, data);
        };
        const create = AudioContext.prototype.createBufferSource;
        AudioContext.prototype.createBufferSource = function () {
          const source = create.call(this),
            context = this,
            start = source.start.bind(source);
          source.start = (when = 0) => {
            const samples = source.buffer?.getChannelData(0);
            if (samples) {
              probe.samples += samples.length;
              for (const sample of samples) probe.energy += sample * sample;
            }
            probe.playedAt ||= performance.now() + Math.max(0, when - context.currentTime) * 1000;
            start(when);
          };
          return source;
        };
      },
      { url }
    );
    page.on('pageerror', error => console.log('VOICE_PAGE_ERROR', error.message));
    await page.goto(vite.resolvedUrls!.local[0] + 'voice-call-test.html');
    await expect(page.getByRole('heading', { name: persona.name })).toBeVisible();
    await page.getByRole('button', { name: '开始通话' }).click();
    await expect(page.getByRole('button', { name: '说完了' })).toBeVisible();
    await expect(page.getByLabel('对方说的话')).toContainText(/\S/, { timeout: 40000 });
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (window as unknown as { voiceProbe: { energy: number } }).voiceProbe.energy
          ),
        { timeout: 20000 }
      )
      .toBeGreaterThan(0);
    const metrics = await page.evaluate(() => {
      const p = (
        window as unknown as {
          voiceProbe: { sentAt: number; playedAt: number; samples: number; energy: number };
        }
      ).voiceProbe;
      return {
        submitToScheduledAudioMs: p.playedAt - p.sentAt,
        samples: p.samples,
        energy: p.energy,
      };
    });
    console.log(
      'VOICE_PIPELINE',
      JSON.stringify({ ...metrics, text: await page.getByLabel('对方说的话').textContent() })
    );
    await expect(page.getByRole('status')).toHaveText('请继续说话', { timeout: 30000 });
    await page.screenshot({ path: 'test-results/voice-call-connected.png' });
    await page.getByRole('button', { name: '静音', exact: true }).click();
    expect(
      await page.evaluate(() =>
        (
          window as unknown as { voiceProbe: { tracks: MediaStreamTrack[] } }
        ).voiceProbe.tracks.every((track) => !track.enabled)
      )
    ).toBe(true);
    await page.getByRole('button', { name: '结束通话' }).click();
    await expect(page.getByRole('status')).toHaveText('通话已结束');
    expect(
      await page.evaluate(() =>
        (
          window as unknown as { voiceProbe: { tracks: MediaStreamTrack[] } }
        ).voiceProbe.tracks.every((track) => track.readyState === 'ended')
      )
    ).toBe(true);
    await page.getByRole('button', { name: '开始通话' }).click();
    await expect(page.getByRole('button', { name: '说完了' })).toBeVisible();
    await page.getByRole('button', { name: '结束通话' }).click();
  } finally {
    await browser.close();
    await vite.close();
    for (const client of calls.clients) client.terminate();
    calls.close();
    await new Promise<void>((done) => transport.close(() => done()));
    await rm(cache, { recursive: true, force: true });
  }
});
