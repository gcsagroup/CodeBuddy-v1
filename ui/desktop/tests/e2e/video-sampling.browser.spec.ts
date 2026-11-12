import { chromium, expect, test, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve, join, dirname, basename } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

let server: ViteDevServer;
let browser: Browser;
let root: string;
test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'codebuddy-video-sampling-'));
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x90:rate=10',
    '-t',
    '12',
    '-c:v',
    'libvpx',
    join(root, 'sample.webm'),
  ]);
  server = await createServer({
    configFile: resolve('vite.renderer.config.mts'),
    cacheDir: join(root, 'cache'),
    optimizeDeps: { entries: ['tests/browser-fixtures/video-sampling.html'] },
    server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  await server.listen();
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
});
test.afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (root && dirname(root) === tmpdir() && basename(root).startsWith('codebuddy-video-sampling-'))
    await rm(root, { recursive: true, force: true });
});
test('real browser decodes a clip, reports timed evidence and rejects corrupt input', async () => {
  const page = await browser.newPage();
  await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/video-sampling.html');
  await page.getByLabel('Video', { exact: true }).setInputFiles(join(root, 'sample.webm'));
  await expect(page.getByRole('img')).toHaveCount(6);
  const evidence = await page.getByTestId('evidence').textContent();
  const record = JSON.parse(evidence!.split('\n')[3])[0];
  expect(record.durationSeconds).toBeCloseTo(12, 1);
  expect(record.frames[0]).toEqual({ imageNumber: 1, timestamp: '0:00.250' });
  expect(record.frames.at(-1)).toEqual({ imageNumber: 6, timestamp: '0:11.750' });
  expect(record.audioAnalyzed).toBe(false);
  expect(
    new Set(
      await page
        .getByRole('img')
        .evaluateAll((images) => images.map((image) => (image as HTMLImageElement).src))
    ).size
  ).toBe(6);
  await page.screenshot({ path: test.info().outputPath('video-sampling.png'), fullPage: true });
  await writeFile(join(root, 'broken.webm'), 'not video');
  await page.getByLabel('Video', { exact: true }).setInputFiles(join(root, 'broken.webm'));
  await expect(page.getByRole('alert')).toContainText('could not be decoded');
  expect(await page.getByTestId('evidence').textContent()).not.toContain('broken.webm');
  await page.close();
});

test('gallery tiles show the first decoded frame of each video', async () => {
  const files = ['red', 'lime'].map((color) => {
    const file = join(root, color + '.mp4');
    // The remaining frames are blue, so a sample from later in the clip would fail.
    execFileSync('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=' + color + ':s=80x60:r=10:d=0.1',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=80x60:r=10:d=1',
      '-filter_complex',
      'concat=n=2:v=1:a=0',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      file,
    ]);
    return file;
  });
  const page = await browser.newPage();
  try {
    await page.goto(server.resolvedUrls!.local[0] + 'tests/browser-fixtures/video-sampling.html');
    await page.getByLabel('Gallery previews').setInputFiles(files);
    await expect
      .poll(() =>
        page.locator('canvas').evaluateAll((canvases) =>
          canvases.map((canvas) => {
            const [r, g, b, a] = (canvas as HTMLCanvasElement)
              .getContext('2d')!
              .getImageData(64, 64, 1, 1).data;
            return a === 255 && r > 200 && g < 30
              ? 'red'
              : a === 255 && g > 200 && b < 30
                ? 'green'
                : 'other';
          })
        )
      )
      .toEqual(['red', 'green']);
  } finally {
    await page.close();
  }
});
