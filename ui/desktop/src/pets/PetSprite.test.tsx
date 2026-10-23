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

it('starts a newly selected action at its first pose after idle has advanced', () => {
  const view = render(<PetSprite pet={pet} />);
  act(() => {
    vi.advanceTimersByTime(510);
  });
  expect(drawImage.mock.calls[drawImage.mock.calls.length - 1]?.[1]).toBeGreaterThan(0);
  view.rerender(<PetSprite pet={pet} animation="jump" />);
  expect(drawImage.mock.calls[drawImage.mock.calls.length - 1]?.slice(1, 3)).toEqual([0, 416]);
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
