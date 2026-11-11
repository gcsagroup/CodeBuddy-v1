import { describe, expect, it } from 'vitest';
import { actionDuration, blendPandaPose, followGaze, samplePandaPose } from './pandaMotion';

const center = { x: 0, y: 0 };
describe('panda motion acceptance curves', () => {
  it('keeps idle feet on the ground with small body movement', () => {
    for (let t = 0; t < 12000; t += 16) {
      const p = samplePandaPose('idle', t, t, center);
      expect(p.lift).toBe(0);
      expect(Math.abs(p.squash)).toBeLessThanOrEqual(0.004);
      expect(Math.abs(p.headY)).toBeLessThanOrEqual(0.35);
    }
  });
  it('crouches before takeoff, rises, lands and returns to the ground', () => {
    const sample = (fraction: number) =>
      samplePandaPose('jump', fraction * actionDuration.jump, 0, center);
    expect(sample(0.16).squash).toBeGreaterThan(0.1);
    expect(sample(0.16).lift).toBeCloseTo(0);
    expect(sample(0.45).lift).toBeLessThan(-45);
    expect(sample(0.73).lift).toBeCloseTo(0);
    expect(sample(0.73).squash).toBeGreaterThan(0.07);
    expect(sample(1).lift).toBeCloseTo(0);
    expect(sample(1).squash).toBeCloseTo(0);
  });
  it('finishes waving in the neutral pose instead of snapping back', () => {
    expect(samplePandaPose('wave', 900, 0, center).arm).toBeLessThan(-1.8);
    expect(samplePandaPose('wave', actionDuration.wave, 0, center).arm).toBeCloseTo(0);
    const before = samplePandaPose('wave', actionDuration.wave - 1, 0, center);
    expect(Math.abs(before.arm)).toBeLessThan(0.001);
  });
  it('smooths the same gaze at the same rate across display refresh rates', () => {
    const follow = (hz: number) => {
      let x = 0;
      for (let i = 0; i < hz; i++) x = followGaze(x, 1, 1000 / hz);
      return x;
    };
    expect(follow(60)).toBeCloseTo(follow(144), 10);
    expect(followGaze(0, 20, 16)).toBeLessThan(1);
  });
  it('starts an interrupted action at its displayed pose', () => {
    const from = samplePandaPose('wave', 900, 900, center);
    const to = samplePandaPose('jump', 0, 900, center);
    expect(blendPandaPose(from, to, 0)).toEqual(from);
    expect(blendPandaPose(from, to, 1)).toEqual(to);
  });
});
