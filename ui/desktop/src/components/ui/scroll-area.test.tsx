/* global Element */
import { createRef, useContext } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ScrollArea, type ScrollAreaHandle } from './scroll-area';
import { ScrollLayoutAnchorContext } from './scroll-follow-context';

afterEach(() => vi.unstubAllGlobals());

it('restores a prepended batch synchronously even when a reading anchor already exists', () => {
  let hold: ((element: Element) => () => void) | null = null;
  function ReadingContent() {
    hold = useContext(ScrollLayoutAnchorContext);
    return (
      <section>
        <p>Current paragraph</p>
      </section>
    );
  }
  const ref = createRef<ScrollAreaHandle>();
  const view = render(
    <ScrollArea ref={ref} autoScroll>
      <ReadingContent />
    </ScrollArea>
  );
  const viewport = ref.current!.viewportRef.current!;
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 500 });
  Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 3000 });
  const rect = (top: number, height = 30) => ({
    top,
    bottom: top + height,
    left: 0,
    right: 500,
    x: 0,
    y: top,
    width: 500,
    height,
    toJSON() {},
  });
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect(0, 500));
  let offset = 350;
  const paragraph = view.getByText('Current paragraph');
  vi.spyOn(paragraph, 'getBoundingClientRect').mockImplementation(() =>
    rect(offset - viewport.scrollTop)
  );
  fireEvent.wheel(viewport, { deltaY: -20 });
  viewport.scrollTop = 300;
  fireEvent.scroll(viewport);
  const release = hold!(paragraph.parentElement!);
  offset += 800;
  release();
  expect(viewport.scrollTop).toBe(1100);
  expect(paragraph.getBoundingClientRect().top).toBe(50);
  expect(ref.current!.isFollowing).toBe(false);
});

it('keeps the file heading in place when a bottom show-more button moves down', () => {
  const observers: Array<() => void> = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  const ref = createRef<ScrollAreaHandle>();
  const view = render(
    <ScrollArea ref={ref} autoScroll>
      <div data-disclosure-anchor="">
        <button data-disclosure-heading="" aria-expanded="true">
          Modified files
        </button>
        <button aria-expanded="false">Show remaining files</button>
      </div>
    </ScrollArea>
  );
  const viewport = ref.current!.viewportRef.current!;
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 500 });
  Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1500 });
  viewport.scrollTop = 250;
  const rect = (top: number) => ({
    top,
    bottom: top + 30,
    width: 500,
    height: 30,
    x: 0,
    y: top,
    left: 0,
    right: 500,
    toJSON() {},
  });
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect(0));
  const heading = view.getByText('Modified files');
  vi.spyOn(heading, 'getBoundingClientRect').mockImplementation(() =>
    rect(320 - viewport.scrollTop)
  );
  const more = view.getByText('Show remaining files');
  const movingButton = vi.spyOn(more, 'getBoundingClientRect').mockReturnValue(rect(240));
  fireEvent.click(more);
  movingButton.mockReturnValue(rect(640));
  act(() => observers.forEach((callback) => callback()));
  expect(viewport.scrollTop).toBe(250);
  expect(heading.getBoundingClientRect().top).toBe(70);
  expect(ref.current!.isFollowing).toBe(false);
});

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
