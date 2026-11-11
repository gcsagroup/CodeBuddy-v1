export type PandaAction = 'idle' | 'look' | 'wave' | 'jump';
export type PandaPose = {
  lift: number;
  squash: number;
  lean: number;
  head: number;
  headX: number;
  headY: number;
  arm: number;
  tail: number;
  blink: boolean;
};

export const actionDuration: Record<PandaAction, number> = {
  idle: Infinity,
  look: Infinity,
  wave: 2400,
  jump: 1700,
};
const clamp = (n: number, low = 0, high = 1) => Math.max(low, Math.min(high, n));
const smooth = (n: number) => {
  const x = clamp(n);
  return x * x * (3 - 2 * x);
};

// Time-based curves keep identical motion speed on 60/120/144 Hz displays.
// Feet remain planted during breathing; only a jump moves the root.
export function samplePandaPose(
  action: PandaAction,
  elapsed: number,
  time: number,
  gaze: { x: number; y: number }
): PandaPose {
  const breath = Math.sin((time / 4300) * Math.PI * 2);
  const pose: PandaPose = {
    lift: 0,
    squash: breath * 0.004,
    lean: 0,
    head: Math.sin((time / 6100) * Math.PI * 2) * 0.008,
    headX: 0,
    headY: breath * 0.35,
    arm: 0,
    tail: Math.sin((time / 5700) * Math.PI * 2 - 0.7) * 0.025,
    blink: false,
  };
  if (action === 'look') {
    pose.head += gaze.x * 0.09;
    pose.headX = gaze.x * 5;
    pose.headY += gaze.y * 3;
    pose.lean = gaze.x * 0.012;
  }
  if (action === 'wave') {
    const envelope = smooth(elapsed / 400) * (1 - smooth((elapsed - 1750) / 650));
    pose.arm = envelope * (-2.25 + Math.sin(((elapsed - 380) / 420) * Math.PI * 2) * 0.2);
    pose.head -= envelope * 0.045;
    pose.tail += Math.sin((elapsed / 600) * Math.PI * 2 - 0.9) * 0.045 * envelope;
  }
  if (action === 'jump') {
    const p = clamp(elapsed / actionDuration.jump);
    const crouch = smooth(p / 0.16) * (1 - smooth((p - 0.16) / 0.1));
    const flight = clamp((p - 0.24) / 0.42);
    const landing = smooth((p - 0.66) / 0.05) * (1 - smooth((p - 0.71) / 0.25));
    pose.lift = -4 * flight * (1 - flight) * 48;
    pose.squash = crouch * 0.12 + landing * 0.09 - Math.sin(flight * Math.PI) * 0.035;
    pose.arm = -Math.sin(flight * Math.PI) * 0.6;
    pose.headY += crouch * 3 - Math.sin(flight * Math.PI) * 1.6;
    pose.tail += Math.sin(flight * Math.PI * 1.5) * 0.15;
  }
  return pose;
}

export function blendPandaPose(from: PandaPose, to: PandaPose, fraction: number): PandaPose {
  if (fraction <= 0) return { ...from };
  if (fraction >= 1) return { ...to };
  const amount = smooth(fraction);
  const result = { ...to };
  for (const key of Object.keys(to) as Array<keyof PandaPose>) {
    if (key !== 'blink') result[key] = from[key] + (to[key] - from[key]) * amount;
  }
  return result;
}

export function followGaze(current: number, target: number, delta: number): number {
  return current + (clamp(target, -1, 1) - current) * (1 - Math.exp(-delta / 160));
}
