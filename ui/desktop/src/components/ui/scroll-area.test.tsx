import { createRef } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ScrollArea, type ScrollAreaHandle } from './scroll-area';

afterEach(() => vi.unstubAllGlobals());

it('reports actual bottom after layout and scroll events without changing reading intent', () => {
  const observers: Array<{ callback: () => void; disconnect: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      callback: () => void;
      disconnect = vi.fn();
      constructor(callback: () => void) {
        this.callback = callback;
        observers.push(this);
      }
      observe() {}
      unobserve() {}
    }
  );
  const ref = createRef<ScrollAreaHandle>();
  const onBottom = vi.fn(),
    onFollowing = vi.fn();
  const view = render(
    <ScrollArea ref={ref} autoScroll onBottomChange={onBottom} onScrollChange={onFollowing}>
      <details>
        <summary>Reasoning</summary>
        <p>Content</p>
      </details>
    </ScrollArea>
  );
  const viewport = ref.current!.viewportRef.current!;
  const end = viewport.querySelector('div[style="height: 1px;"]')!;
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 500 });
  const rect = (bottom: number) => ({
    top: 0,
    bottom,
    width: 500,
    height: bottom,
    x: 0,
    y: 0,
    left: 0,
    right: 500,
    toJSON() {},
  });
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect(500));
  const measureEnd = vi.spyOn(end, 'getBoundingClientRect').mockReturnValue(rect(500.5));
  act(() => observers.forEach((o) => o.callback()));
  fireEvent.click(view.getByText('Reasoning'));
  expect(onFollowing).toHaveBeenLastCalledWith(false);
  expect(onBottom).toHaveBeenLastCalledWith(true);
  measureEnd.mockReturnValue(rect(800));
  act(() => observers.forEach((o) => o.callback()));
  expect(onBottom).toHaveBeenLastCalledWith(false);
  measureEnd.mockReturnValue(rect(499));
  fireEvent.scroll(viewport);
  expect(onBottom).toHaveBeenLastCalledWith(true);
  expect(onFollowing).toHaveBeenLastCalledWith(false);
  view.unmount();
  expect(observers.every((o) => o.disconnect.mock.calls.length > 0)).toBe(true);
});
