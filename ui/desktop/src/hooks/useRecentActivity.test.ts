import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useRecentActivity } from './useRecentActivity';

afterEach(() => vi.useRealTimers());
it('expires an arrival badge without another message and accepts subsequent activity', () => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  const view = renderHook(({ at }: { at?: number }) => useRecentActivity(at), {
    initialProps: { at: 10000 },
  });
  expect(view.result.current).toBe(true);
  act(() => vi.advanceTimersByTime(3001));
  expect(view.result.current).toBe(false);
  view.rerender({ at: Date.now() });
  expect(view.result.current).toBe(true);
});
