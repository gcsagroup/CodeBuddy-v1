import { describe, it, expect } from 'vitest';
import { UtteranceCapture } from './utterance';
describe('local utterance boundaries', () => {
  it('ignores low noise and submits speech after a pause', () => {
    let starts = 0;
    const clips: ArrayBuffer[] = [];
    const vad = new UtteranceCapture(
      () => starts++,
      (wav) => clips.push(wav)
    );
    for (let i = 0; i < 200; i++) vad.push(new Float32Array(320).fill(0.001));
    expect(starts).toBe(0);
    for (let i = 0; i < 30; i++) vad.push(new Float32Array(320).fill(0.1));
    for (let i = 0; i < 34; i++) vad.push(new Float32Array(320));
    expect(starts).toBe(1);
    expect(clips).toHaveLength(1);
    expect(new DataView(clips[0]).getUint32(24, true)).toBe(16000);
  });
  it('manual finish submits once and reset discards muted speech', () => {
    const clips: ArrayBuffer[] = [];
    const vad = new UtteranceCapture(
      () => {},
      (wav) => clips.push(wav)
    );
    for (let i = 0; i < 20; i++) vad.push(new Float32Array(320).fill(0.1));
    vad.finish();
    vad.finish();
    expect(clips).toHaveLength(1);
    for (let i = 0; i < 20; i++) vad.push(new Float32Array(320).fill(0.1));
    vad.reset();
    vad.finish();
    expect(clips).toHaveLength(1);
  });
  it('bounds continuous audio instead of waiting forever', () => {
    const clips: ArrayBuffer[] = [];
    const vad = new UtteranceCapture(
      () => {},
      (wav) => clips.push(wav)
    );
    for (let i = 0; i < 710; i++) vad.push(new Float32Array(320).fill(0.1));
    expect(clips).toHaveLength(1);
    expect(clips[0].byteLength).toBeLessThanOrEqual(44 + 15 * 32000);
  });
});
