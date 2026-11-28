/* global Element */
import { createRef, useContext } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ScrollArea, type ScrollAreaHandle } from './scroll-area';
import { ScrollLayoutAnchorContext } from './scroll-follow-context';

afterEach(() => vi.unstubAllGlobals());

it('follows the latest floor after fast content or viewport growth, without leaving an idle animation', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  const observers: Array<{ targets: Set<Element>; callback: () => void }> = [];
  vi.stubGlobal('ResizeObserver', class {
    targets = new Set<Element>();
    constructor(public callback: () => void) { observers.push(this); }
    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  });
  const flushFrame = () => act(() => {
    const ready = [...frames.values()];
    frames.clear();
    ready.forEach(callback => callback(performance.now()));
  });
  const resize = (target: Element) => act(() => {
    observers.filter(observer => observer.targets.has(target)).forEach(observer => observer.callback());
  });
  const ref = createRef<ScrollAreaHandle>();
  const view = render(<ScrollArea ref={ref} autoScroll><p>Streaming content</p></ScrollArea>);
  const viewport = ref.current!.viewportRef.current!;
  let height = 1000, viewportHeight = 500;
  Object.defineProperty(viewport, 'scrollHeight', { get: () => height });
  Object.defineProperty(viewport, 'clientHeight', { get: () => viewportHeight });
  viewport.scrollTop = 500;
  flushFrame();
  height += 1800;
  resize(view.getByText('Streaming content').parentElement!);
  flushFrame();
  flushFrame();
  expect(viewport.scrollTop).toBe(2300);
  expect(frames.size).toBe(0);
  viewportHeight = 300;
  resize(viewport);
  flushFrame();
  flushFrame();
  expect(viewport.scrollTop).toBe(2500);
  expect(ref.current!.isFollowing).toBe(true);
  view.unmount();
  expect(frames.size).toBe(0);
});

it('pauses for a changed chat selection but lets an explicit jump resume with the old selection intact', () => {
  const ref = createRef<ScrollAreaHandle>();
  const view = render(<>
    <p>Outside text</p>
    <ScrollArea ref={ref} autoScroll><p>Selected chat text</p></ScrollArea>
  </>);
  const viewport = ref.current!.viewportRef.current!;
  viewport.scrollTo = vi.fn();
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.setStart(view.getByText('Selected chat text').firstChild!, 0);
  range.setEnd(view.getByText('Selected chat text').firstChild!, 8);
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent(document, new Event('selectionchange'));
  expect(ref.current!.isFollowing).toBe(false);
  act(() => ref.current!.scrollToBottom());
  fireEvent(document, new Event('selectionchange'));
  expect(ref.current!.isFollowing).toBe(true);
  expect(selection.toString()).toBe('Selected');
  range.setEnd(view.getByText('Selected chat text').firstChild!, 13);
  fireEvent(document, new Event('selectionchange'));
  expect(ref.current!.isFollowing).toBe(false);
  selection.removeAllRanges();
  fireEvent(document, new Event('selectionchange'));
  expect(ref.current!.isFollowing).toBe(false);
  act(() => ref.current!.scrollToBottom());
  range.selectNodeContents(view.getByText('Outside text'));
  selection.addRange(range);
  fireEvent(document, new Event('selectionchange'));
  expect(ref.current!.isFollowing).toBe(true);
  view.unmount();
  selection.removeAllRanges();
});

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

it('owns browser anchoring only while following and restores it for reading or non-auto containers', () => {
  const ref = createRef<ScrollAreaHandle>();
  const view = render(
    <ScrollArea ref={ref} autoScroll>
      <details>
        <summary>Read thought</summary>
        <p>Original text</p>
      </details>
    </ScrollArea>
  );
  const viewport = ref.current!.viewportRef.current!;
  viewport.scrollTo = vi.fn();
  expect(viewport.style.overflowAnchor).toBe('none');
  fireEvent.focusIn(view.getByText('Read thought'));
  expect(ref.current!.isFollowing).toBe(false);
  expect(viewport.style.overflowAnchor).not.toBe('none');
  act(() => ref.current!.scrollToBottom());
  expect(viewport.style.overflowAnchor).toBe('none');
  view.rerender(
    <ScrollArea ref={ref} autoScroll={false}>
      <p>Static content</p>
    </ScrollArea>
  );
  expect(viewport.style.overflowAnchor).not.toBe('none');
});
