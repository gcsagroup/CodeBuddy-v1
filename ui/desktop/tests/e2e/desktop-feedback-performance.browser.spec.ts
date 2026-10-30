import { chromium, expect, test } from '@playwright/test';
import { desktopFeedbackDocument } from '../../src/desktopFeedbackDocument';

test('measure desktop feedback animation rendering cost', async ({}, testInfo) => {
  const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 2560, height: 1440 } });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setContent(desktopFeedbackDocument('Esc 停止电脑控制'));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const before = await cdp.send('Performance.getMetrics');
    const events: { name: string; dur?: number }[] = [];
    cdp.on('Tracing.dataCollected', ({ value }) => events.push(...value));
    await cdp.send('Tracing.start', { categories: 'devtools.timeline', transferMode: 'ReportEvents' });
    const frames = await page.evaluate(() => new Promise<number[]>(resolve => {
      const intervals: number[] = [];
      let start = 0, last = 0;
      function frame(now: number) {
        if (!start) start = now;
        if (last) intervals.push(now - last);
        last = now;
        if (now - start >= 5000) resolve(intervals);
        else requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    }));
    const after = await cdp.send('Performance.getMetrics');
    const complete = new Promise<void>(resolve => cdp.once('Tracing.tracingComplete', () => resolve()));
    await cdp.send('Tracing.end');
    await complete;
    const sorted = [...frames].sort((a, b) => a - b);
    const metric = (name: string) =>
      (after.metrics.find(m => m.name === name)?.value ?? 0) -
      (before.metrics.find(m => m.name === name)?.value ?? 0);
    const report = {
      viewport: '2560x1440', sampleMs: frames.reduce((a, b) => a + b, 0),
      frameCount: frames.length, p95FrameMs: sorted[Math.floor(sorted.length * .95)],
      framesOver25ms: frames.filter(ms => ms > 25).length,
      paintEvents: events.filter(e => e.name === 'Paint').length,
      paintMs: events.filter(e => e.name === 'Paint').reduce((sum, e) => sum + (e.dur ?? 0), 0) / 1000,
      taskMs: metric('TaskDuration') * 1000,
      layoutCount: metric('LayoutCount'), styleRecalcCount: metric('RecalcStyleCount'),
    };
    console.log(JSON.stringify(report));
    await testInfo.attach('animation-performance', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
    expect(frames.length).toBeGreaterThan(0);
  } finally { await browser.close(); }
});
