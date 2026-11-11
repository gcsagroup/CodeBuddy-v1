/* global Image, CanvasRenderingContext2D, performance */
import {
  actionDuration,
  blendPandaPose,
  followGaze,
  samplePandaPose,
  type PandaAction,
  type PandaPose,
} from './pandaMotion';

type Part = { image: HTMLCanvasElement; width: number; height: number };
export type PandaMetrics = {
  fps: number;
  drawP95: number;
  frameP95: number;
  slowFrames: number;
  samples: number;
  dpr: number;
  active: PandaAction;
};

// The generated atlas is immutable. Trim/cache its eight parts once at load;
// neither alpha scans nor React updates are performed in the animation loop.
export async function loadPandaParts(url: string): Promise<Part[]> {
  const image = new Image();
  image.src = url;
  await image.decode();
  const parts: Part[] = [];
  for (let i = 0; i < 8; i++) {
    const cell = document.createElement('canvas');
    cell.width = Math.floor(image.naturalWidth / 4);
    cell.height = Math.floor(image.naturalHeight / 2);
    const ctx = cell.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(
      image,
      (i % 4) * cell.width,
      Math.floor(i / 4) * cell.height,
      cell.width,
      cell.height,
      0,
      0,
      cell.width,
      cell.height
    );
    const pixels = ctx.getImageData(0, 0, cell.width, cell.height).data;
    let left = cell.width,
      top = cell.height,
      right = -1,
      bottom = -1;
    for (let y = 0; y < cell.height; y++)
      for (let x = 0; x < cell.width; x++) {
        if (pixels[(y * cell.width + x) * 4 + 3] > 24) {
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
      }
    if (right < left) throw new Error(`Empty panda layer ${i}`);
    const trimmed = document.createElement('canvas');
    trimmed.width = right - left + 1;
    trimmed.height = bottom - top + 1;
    trimmed
      .getContext('2d')!
      .drawImage(
        cell,
        left,
        top,
        trimmed.width,
        trimmed.height,
        0,
        0,
        trimmed.width,
        trimmed.height
      );
    parts.push({ image: trimmed, width: trimmed.width, height: trimmed.height });
  }
  return parts;
}

export function drawPanda(
  ctx: CanvasRenderingContext2D,
  parts: Part[],
  pose: PandaPose,
  scale: number,
  shadow = true
) {
  const part = (
    i: number,
    x: number,
    y: number,
    width: number,
    height: number,
    angle = 0,
    pivotX = 0.5,
    pivotY = 0.5
  ) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.drawImage(parts[i].image, -width * pivotX, -height * pivotY, width, height);
    ctx.restore();
  };
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, 240, 320);
  if (shadow) {
    const spread = 1 + pose.lift / 180;
    ctx.fillStyle = `rgba(56,37,22,${0.1 + pose.lift / 1200})`;
    ctx.beginPath();
    ctx.ellipse(122, 295, 43 * spread, 5 * spread, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.translate(120, 290 + pose.lift);
  ctx.rotate(pose.lean);
  // Tail follows the body with a separate delayed arc.
  part(3, 30, -22, 72, 102, pose.tail, 0.16, 0.88);
  part(6, -23, -1, 31, 21, 0, 0.5, 1);
  part(7, 23, -1, 31, 21, 0, 0.5, 1);
  ctx.save();
  ctx.translate(0, -8);
  ctx.scale(1 + pose.squash * 0.4, 1 - pose.squash);
  part(2, 0, 0, 91, 104, 0, 0.5, 1);
  part(4, -37, -83, 27, 46, 0.12, 0.5, 0.12);
  part(pose.blink ? 1 : 0, pose.headX - 4, -95 + pose.headY, 151, 133, pose.head, 0.5, 0.92);
  part(5, 36, -83, 27, 46, pose.arm - 0.12, 0.5, 0.12);
  ctx.restore();
  ctx.restore();
}

export function createPandaRig(
  canvas: HTMLCanvasElement,
  parts: Part[],
  options: {
    size?: number;
    reducedMotion?: boolean;
    onMetrics?: (metrics: PandaMetrics) => void;
  } = {}
) {
  const ctx = canvas.getContext('2d')!;
  const size = options.size ?? 240;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round((size / 240) * 320 * dpr);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${(size / 240) * 320}px`;
  let action: PandaAction = 'idle',
    time = 0,
    started = 0,
    transition = 0;
  let pose = samplePandaPose('idle', 0, 0, { x: 0, y: 0 }),
    previous: PandaPose = pose;
  let gaze = { x: 0, y: 0 },
    target = { x: 0, y: 0 };
  let raf = 0,
    last = 0,
    lastDraw = 0,
    stopped = false;
  let reduced = options.reducedMotion ?? false;
  let nextBlink = 3300 + Math.random() * 2500,
    blinkEnd = 0;
  let reportStart = 0,
    count = 0,
    total = 0,
    slowFrames = 0;
  const draws: number[] = [],
    intervals: number[] = [];
  const draw = () => drawPanda(ctx, parts, pose, canvas.width / 240);
  const activate = (next: PandaAction) => {
    previous = pose;
    action = next;
    started = time;
    transition = time;
    canvas.dataset.action = next;
  };
  const tick = (now: number) => {
    if (stopped || reduced || document.hidden) return;
    raf = requestAnimationFrame(tick);
    const rawDelta = last ? now - last : 0;
    last = now;
    time += Math.min(100, rawDelta);
    if (now - lastDraw < 1000 / 60 - 1) return;
    const drawDelta = lastDraw ? now - lastDraw : 0;
    if (lastDraw) {
      const interval = drawDelta;
      intervals.push(interval);
      if (interval > 50) slowFrames++;
    }
    lastDraw = now;
    const start = performance.now();
    gaze = {
      x: followGaze(gaze.x, target.x, drawDelta),
      y: followGaze(gaze.y, target.y, drawDelta),
    };
    if (time - started >= actionDuration[action]) activate('idle');
    pose = blendPandaPose(
      previous,
      samplePandaPose(action, time - started, time, gaze),
      (time - transition) / 200
    );
    if (time >= nextBlink) {
      blinkEnd = time + 130;
      nextBlink = time + 3500 + Math.random() * 3500;
    }
    pose.blink = time < blinkEnd;
    draw();
    draws.push(performance.now() - start);
    count++;
    total++;
    if (!reportStart) reportStart = now;
    if (now - reportStart >= 1000) {
      const p95 = (values: number[]) =>
        [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * 0.95)] || 0;
      options.onMetrics?.({
        fps: (count * 1000) / (now - reportStart),
        drawP95: p95(draws),
        frameP95: p95(intervals),
        slowFrames,
        samples: total,
        dpr,
        active: action,
      });
      reportStart = now;
      count = 0;
      draws.length = 0;
      intervals.length = 0;
    }
  };
  const resume = () => {
    cancelAnimationFrame(raf);
    last = 0;
    lastDraw = 0;
    reportStart = 0;
    count = 0;
    draws.length = 0;
    intervals.length = 0;
    if (!stopped && !reduced && !document.hidden) raf = requestAnimationFrame(tick);
  };
  const visibility = () => resume();
  document.addEventListener('visibilitychange', visibility);
  canvas.dataset.action = 'idle';
  draw();
  resume();
  return {
    trigger(next: PandaAction) {
      activate(next);
      if (reduced) {
        pose = samplePandaPose('idle', 0, 0, { x: 0, y: 0 });
        draw();
      }
    },
    look(x: number, y: number) {
      target = { x, y };
    },
    setReducedMotion(value: boolean) {
      reduced = value;
      if (reduced) {
        pose = samplePandaPose('idle', 0, 0, { x: 0, y: 0 });
        draw();
      }
      resume();
    },
    dispose() {
      stopped = true;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', visibility);
    },
  };
}
