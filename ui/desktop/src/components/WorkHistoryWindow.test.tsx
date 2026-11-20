import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkHistoryWindow } from './WorkHistoryWindow';

const subscriptions = new Map<HTMLElement, (entry: IntersectionObserverEntry) => void>();

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private notify: IntersectionObserverCallback) {}

    observe(element: HTMLElement) {
      subscriptions.set(element, (entry) => this.notify([entry], this as unknown as IntersectionObserver));
    }

    unobserve(element: HTMLElement) {
      subscriptions.delete(element);
    }

    disconnect() {
      subscriptions.clear();
    }
  });
});

afterEach(() => {
  subscriptions.clear();
  vi.unstubAllGlobals();
});

const rows = Array.from({ length: 72 }, (_, index) => <button key={index}>Work {index}</button>);

function history(keepAllMounted = false, items = rows, prepareSearch = false) {
  return (
    <div data-radix-scroll-area-viewport="">
      <WorkHistoryWindow rows={items} keepAllMounted={keepAllMounted} prepareSearch={prepareSearch} />
    </div>
  );
}

function notifyVisibility(element: HTMLElement, isIntersecting: boolean) {
  const callback = subscriptions.get(element);
  expect(callback).toBeDefined();
  const bounds = window.DOMRect.fromRect({ width: 500, height: 480 });
  act(() => callback!({
    target: element, isIntersecting, boundingClientRect: bounds, rootBounds: bounds,
    intersectionRect: isIntersecting ? bounds : window.DOMRect.fromRect(),
    intersectionRatio: isIntersecting ? 1 : 0, time: 0,
  }));
}

describe('work history window', () => {
  it('releases offscreen records without losing their scroll space or hiding the new work', () => {
    render(history());
    const page = screen.getByText('Work 0').parentElement!;
    notifyVisibility(page, false);
    expect(screen.queryByText('Work 0')).toBeNull();
    expect(page).toHaveStyle({ minHeight: '480px' });
    expect(screen.getByText('Work 71')).toBeInTheDocument();
    notifyVisibility(page, true);
    expect(screen.getByText('Work 0')).toBeInTheDocument();
  });

  it('restores full history when requested and keeps an interacted page mounted', () => {
    const { rerender } = render(history());
    const interacted = screen.getByText('Work 0');
    fireEvent.click(interacted);
    expect(subscriptions.has(interacted.parentElement!)).toBe(false);
    const nextPage = screen.getByText('Work 12').parentElement!;
    notifyVisibility(nextPage, false);
    expect(screen.queryByText('Work 12')).toBeNull();
    rerender(history(true));
    expect(screen.getByText('Work 12')).toBeInTheDocument();
    rerender(history());
    expect(screen.getByText('Work 0')).toBe(interacted);
  });

  it('does not reuse a placeholder for a changed set of history rows', () => {
    const { rerender } = render(history());
    const page = screen.getByText('Work 0').parentElement!;
    notifyVisibility(page, false);
    const replacement = [...rows];
    replacement[1] = <button key="new">New record</button>;
    rerender(history(false, replacement));
    expect(screen.getByText('New record')).toBeInTheDocument();
    expect(page).not.toHaveStyle({ minHeight: '480px' });
  });

  it('still releases an old page after a plain text click', () => {
    const withText = [<p key="prose">Plain prose</p>, ...rows.slice(1)];
    render(history(false, withText));
    const prose = screen.getByText('Plain prose');
    const page = prose.parentElement!;
    fireEvent.click(prose);
    notifyVisibility(page, false);
    expect(screen.queryByText('Plain prose')).toBeNull();
  });

  it('fills a distant destination on scroll without restoring the rest of history', () => {
    const { container } = render(history());
    const viewport = container.firstElementChild as HTMLElement;
    const first = screen.getByText('Work 0').parentElement!;
    const destination = screen.getByText('Work 12').parentElement!;
    notifyVisibility(first, false);
    notifyVisibility(destination, false);
    Object.defineProperty(viewport, 'clientHeight', { value: 400 });
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(window.DOMRect.fromRect({ width: 500, height: 400 }));
    vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(window.DOMRect.fromRect({ y: -500, width: 500, height: 480 }));
    vi.spyOn(destination, 'getBoundingClientRect').mockReturnValue(window.DOMRect.fromRect({ width: 500, height: 480 }));
    viewport.scrollTop = 1200;
    fireEvent.scroll(viewport);
    expect(screen.getByText('Work 12')).toBeVisible();
    expect(screen.queryByText('Work 0')).toBeNull();
  });

  it('fills only the skipped pages inside a drag selection and releases them when it clears', () => {
    const textRows = rows.map((_, index) => <p key={index}>Work {index}</p>);
    render(history(false, textRows));
    const start = screen.getByText('Work 12');
    const end = screen.getByText('Work 60');
    for (const index of [0, 24, 36]) notifyVisibility(screen.getByText(`Work ${index}`).parentElement!, false);

    const selection = window.getSelection()!;
    const selectText = () => {
      selection.setBaseAndExtent(end.lastChild!, end.lastChild!.textContent!.length, start.firstChild!, 0);
      fireEvent(document, new Event('selectionchange'));
    };
    try {
      selectText();
      expect(selection.toString()).not.toContain('Work 24');
      fireEvent.pointerDown(end, { pointerId: 1, button: 0, isPrimary: true });
      selectText();
      fireEvent.pointerUp(start, { pointerId: 1 });
      expect(selection.toString()).toContain('Work 24');
      expect(selection.toString()).toContain('Work 36');
      expect(screen.queryByText('Work 0')).toBeNull();

      selection.removeAllRanges();
      fireEvent(document, new Event('selectionchange'));
      expect(screen.queryByText('Work 24')).toBeNull();
      expect(screen.queryByText('Work 36')).toBeNull();
    } finally {
      selection.removeAllRanges();
    }
  });

  it('cancels queued mounts when the query is cleared before the next frame', async () => {
    const { rerender } = render(history());
    const page = screen.getByText('Work 0').parentElement!;
    notifyVisibility(page, false);
    rerender(history(false, rows, true));
    expect(page).toHaveAttribute('data-work-history-search-pending');
    rerender(history());
    await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    expect(page).not.toHaveAttribute('data-work-history-search-pending');
    expect(screen.queryByText('Work 0')).toBeNull();
  });
});
