/* global FrameRequestCallback, CanvasRenderingContext2D */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPandaRig } from './pandaRig';

const drawImage = vi.fn();
let callbacks: Map<number, FrameRequestCallback>;
let nextId: number;
beforeEach(() => {
  callbacks = new Map();
  nextId = 0;
  drawImage.mockClear();
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      callbacks.set(++nextId, callback);
      return nextId;
    })
  );
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id: number) => callbacks.delete(id))
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    ellipse: vi.fn(),
    fill: vi.fn(),
    drawImage,
  } as unknown as CanvasRenderingContext2D);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const make = (reducedMotion = false) =>
  createPandaRig(
    document.createElement('canvas'),
    Array.from({ length: 8 }, () => ({
      image: document.createElement('canvas'),
      width: 100,
      height: 100,
    })),
    { reducedMotion }
  );

it('draws a static pose without scheduling frames in reduced motion', () => {
  const rig = make(true);
  expect(drawImage).toHaveBeenCalled();
  expect(callbacks.size).toBe(0);
  rig.setReducedMotion(false);
  expect(callbacks.size).toBe(1);
  rig.setReducedMotion(true);
  expect(callbacks.size).toBe(0);
  rig.dispose();
});

it('stops scheduling when hidden, resumes once and releases resources on disposal', () => {
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  const remove = vi.spyOn(document, 'removeEventListener');
  const rig = make();
  expect(callbacks.size).toBe(1);
  hidden.mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(callbacks.size).toBe(0);
  hidden.mockReturnValue(false);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(callbacks.size).toBe(1);
  rig.dispose();
  expect(callbacks.size).toBe(0);
  expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  document.dispatchEvent(new Event('visibilitychange'));
  expect(callbacks.size).toBe(0);
});
