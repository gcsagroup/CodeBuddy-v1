import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { PetSprite } from './PetSprite';
import type { PetAsset } from './petTypes';

const pet: PetAsset = {
  schemaVersion: 1,
  id: 'red-panda',
  name: 'Panda',
  description: '',
  image: 'sprites.png',
  columns: 6,
  rows: 8,
  cellWidth: 192,
  cellHeight: 208,
  fps: 6,
  builtin: true,
  hash: 'test',
  imageUrl: 'test.png',
};
const drawImage = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  drawImage.mockClear();
  vi.stubGlobal(
    'Image',
    class {
      onload: (() => void) | null = null;
      set src(_value: string) {
        this.onload?.();
      }
    }
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect: vi.fn(),
    drawImage,
  } as unknown as ReturnType<HTMLCanvasElement['getContext']>);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('holds idle still between short gestures and starts a new action at its first pose', () => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const view = render(<PetSprite pet={pet} />);
  const count = drawImage.mock.calls.length;
  act(() => {
    vi.advanceTimersByTime(3999);
  });
  expect(drawImage).toHaveBeenCalledTimes(count);
  act(() => {
    vi.advanceTimersByTime(101);
  });
  expect(drawImage.mock.calls[drawImage.mock.calls.length - 1]?.[1]).toBeGreaterThan(0);
  view.rerender(<PetSprite pet={pet} animation="jump" />);
  expect(drawImage.mock.calls[drawImage.mock.calls.length - 1]?.slice(1, 3)).toEqual([0, 416]);
});

it.each(['wave', 'jump', 'working', 'waiting', 'failed', 'review'] as const)(
  'settles %s after two complete cycles, without restarting on repeated snapshots',
  (animation) => {
    const view = render(<PetSprite pet={pet} animation={animation} playbackKey="task-1" />);
    act(() => {
      vi.advanceTimersByTime(1990);
    });
    expect(view.getByRole('img')).toHaveAttribute('data-animation', animation);
    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(view.getByRole('img')).toHaveAttribute('data-animation', 'idle');
    view.rerender(<PetSprite pet={{ ...pet }} animation={animation} playbackKey="task-1" />);
    expect(view.getByRole('img')).toHaveAttribute('data-animation', 'idle');
    view.rerender(<PetSprite pet={pet} animation={animation} playbackKey="task-2" />);
    expect(view.getByRole('img')).toHaveAttribute('data-animation', animation);
    expect(view.getByRole('img')).toHaveAttribute('data-frame', '0');
  }
);

it('cancels the old action when interrupted and clears scheduled work on unmount', () => {
  const view = render(<PetSprite pet={pet} animation="wave" />);
  act(() => {
    vi.advanceTimersByTime(1500);
  });
  view.rerender(<PetSprite pet={pet} animation="jump" />);
  act(() => {
    vi.advanceTimersByTime(600);
  });
  expect(view.getByRole('img')).toHaveAttribute('data-animation', 'jump');
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps reduced motion still and selects the requested gaze pose', () => {
  const view = render(<PetSprite pet={pet} animation="wave" reducedMotion />);
  const count = drawImage.mock.calls.length;
  act(() => {
    vi.advanceTimersByTime(5000);
  });
  expect(drawImage).toHaveBeenCalledTimes(count);
  expect(drawImage.mock.calls[drawImage.mock.calls.length - 1]?.slice(1, 3)).toEqual([0, 208]);
  view.rerender(<PetSprite pet={pet} animation="look" gazeFrame={5} />);
  expect(drawImage.mock.calls[drawImage.mock.calls.length - 1]?.slice(1, 3)).toEqual([960, 1456]);
});

it('cycles observation directions in preview when no live cursor pose is supplied', () => {
  render(<PetSprite pet={pet} animation="look" />);
  act(() => {
    vi.advanceTimersByTime(510);
  });
  expect(drawImage.mock.calls[drawImage.mock.calls.length - 1]?.[1]).toBeGreaterThan(0);
  expect(drawImage.mock.calls[drawImage.mock.calls.length - 1]?.[2]).toBe(1456);
});
