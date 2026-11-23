import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useHoldToTalk } from './useHoldToTalk';

afterEach(() => vi.useRealTimers());
it('starts after holding, starts once, and stops on global release', () => {
  vi.useFakeTimers();
  const start = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn();
  const { result } = renderHook(() => useHoldToTalk(start, stop, true, 'chat'));
  act(() => { result.current.begin(); result.current.begin(); vi.advanceTimersByTime(199); });
  expect(start).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(start).toHaveBeenCalledTimes(1);
  act(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' })));
  expect(stop).toHaveBeenCalledTimes(1);
});
it('cancels a short press and a pending hold when the conversation changes', () => {
  vi.useFakeTimers();
  const start = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn();
  const { result, rerender } = renderHook(({ scope }) => useHoldToTalk(start, stop, true, scope), { initialProps: { scope: 'first' } });
  act(() => { result.current.begin(); result.current.end(); vi.advanceTimersByTime(200); });
  expect(start).not.toHaveBeenCalled();
  act(() => result.current.begin());
  rerender({ scope: 'second' });
  act(() => vi.advanceTimersByTime(200));
  expect(start).not.toHaveBeenCalled();
});
