import { isValidElement, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';

const ROWS_PER_PAGE = 12;
const MIN_WINDOWED_ROWS = ROWS_PER_PAGE * 4;

const searchPages = new Map<() => void, boolean>();
let searchFrame: number | undefined;

function loadSearchPages() {
  searchFrame = undefined;
  const until = window.performance.now() + 7;
  for (const [update, releasing] of searchPages) {
    searchPages.delete(update);
    flushSync(update);
    // DOM removal can trigger additional layout work after React returns.
    if (releasing || window.performance.now() >= until) break;
  }
  if (searchPages.size) searchFrame ??= requestAnimationFrame(loadSearchPages);
}

function queueSearchPage(update: () => void, releasing = false) {
  searchPages.set(update, releasing);
  searchFrame ??= requestAnimationFrame(loadSearchPages);
  return () => {
    searchPages.delete(update);
    if (searchPages.size === 0 && searchFrame !== undefined) {
      cancelAnimationFrame(searchFrame);
      searchFrame = undefined;
    }
  };
}

type HistoryPageVisibility = {
  setHeight: (offscreenHeight: number | null) => void;
  setSelected: (selected: boolean) => void;
};
type ObservePage = (element: HTMLElement, visibility: HistoryPageVisibility) => () => void;

function HistoryPage({ children, observe, keepMounted, measuredLayout, rowKeys, prepareSearch }: {
  children: ReactNode;
  observe: ObservePage;
  keepMounted: boolean;
  measuredLayout: boolean;
  rowKeys: string;
  prepareSearch: boolean;
}) {
  const pageRef = useRef<HTMLDivElement>(null);
  const [offscreen, setOffscreen] = useState<{ height: number; rowKeys: string } | null>(null);
  const [interacted, setInteracted] = useState(false);
  const [searchMounted, setSearchMounted] = useState(false);
  const [selected, setSelected] = useState(false);
  const savedHeight = offscreen?.rowKeys === rowKeys ? offscreen.height : undefined;
  const pinned = keepMounted || interacted || searchMounted || (prepareSearch && savedHeight === undefined);
  const searchPending = prepareSearch && !pinned && !selected;

  useEffect(() => {
    if (searchPending) return queueSearchPage(() => setSearchMounted(true));
    if (!prepareSearch && searchMounted) return queueSearchPage(() => setSearchMounted(false), true);
    return undefined;
  }, [prepareSearch, searchPending, searchMounted]);

  useEffect(() => {
    if (pinned || !pageRef.current) return;
    return observe(pageRef.current, {
      setHeight: height => setOffscreen(height === null ? null : { height, rowKeys }),
      setSelected,
    });
  }, [observe, pinned, rowKeys]);

  const height = pinned || selected ? undefined : savedHeight;
  // Search needs the text of restored pages. The browser can defer the layout
  // of their offscreen content while keeping the measured scroll space.
  const restoredForSearch = searchMounted && !interacted && !keepMounted && !selected && savedHeight !== undefined;
  return (
    <div
      ref={pageRef}
      className={measuredLayout ? 'flow-root' : 'contents'}
      style={height !== undefined ? { minHeight: height } : restoredForSearch ? {
        contentVisibility: 'auto',
        containIntrinsicBlockSize: `auto ${savedHeight}px`,
      } : undefined}
      data-work-history-placeholder={height === undefined ? undefined : ''}
      data-work-history-search-pending={searchPending ? '' : undefined}
      onClickCapture={event => {
        // Keep stateful disclosures and previews, while ordinary reading and
        // selection are protected only for as long as they are active.
        if (event.target instanceof window.Element &&
          event.target.closest('button, summary, a, input, [role="button"]')) setInteracted(true);
      }}
    >
      {height === undefined ? children : null}
    </div>
  );
}

function rowKey(row: ReactNode, index: number): string {
  return isValidElement(row) && row.key !== null ? String(row.key) : String(index);
}

export function WorkHistoryWindow({ rows, keepAllMounted, prepareSearch = false }: {
  rows: readonly ReactNode[];
  keepAllMounted: boolean;
  prepareSearch?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const observer = useRef<IntersectionObserver | null>(null);
  const callbacks = useRef(new Map<HTMLElement, HistoryPageVisibility>());
  const measuredLayout = rows.length > MIN_WINDOWED_ROWS;
  const observe = useCallback<ObservePage>((element, visibility) => {
    callbacks.current.set(element, visibility);
    observer.current?.observe(element);
    return () => {
      callbacks.current.delete(element);
      observer.current?.unobserve(element);
    };
  }, []);

  useEffect(() => {
    if (!measuredLayout || keepAllMounted || typeof IntersectionObserver === 'undefined') return;
    const viewport = hostRef.current?.closest<HTMLElement>('[data-radix-scroll-area-viewport]');
    if (!viewport) return;
    const doc = viewport.ownerDocument;
    let dragPointer: number | undefined;
    let selectedPages = new Map<HTMLElement, HistoryPageVisibility>();

    // Native ranges include only mounted text. Fill skipped pages inside the
    // drag range and keep its endpoints intact when the mouse is released.
    const syncSelection = () => {
      if (dragPointer === undefined && selectedPages.size === 0) return;
      const native = doc.getSelection();
      const range = native && !native.isCollapsed && native.rangeCount > 0 && viewport.contains(native.anchorNode)
        ? native.getRangeAt(0) : undefined;
      const next = new Map<HTMLElement, HistoryPageVisibility>();
      const added: HistoryPageVisibility[] = [];
      const removed: HistoryPageVisibility[] = [];
      if (range) {
        const pages = dragPointer === undefined ? selectedPages : callbacks.current;
        for (const [page, visibility] of pages) {
          if (!page.isConnected || !range.intersectsNode(page)) continue;
          next.set(page, visibility);
          if (!selectedPages.has(page)) added.push(visibility);
        }
      }
      for (const [page, visibility] of selectedPages) {
        if (!next.has(page) && page.isConnected) removed.push(visibility);
      }
      selectedPages = next;
      if (added.length || removed.length) flushSync(() => {
        for (const page of added) page.setSelected(true);
        for (const page of removed) page.setSelected(false);
      });
    };
    const beginDrag = (event: globalThis.PointerEvent) => {
      if (event.isPrimary && event.button === 0) dragPointer = event.pointerId;
    };
    const finishDrag = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== dragPointer) return;
      syncSelection();
      dragPointer = undefined;
    };
    const releaseDrag = () => { dragPointer = undefined; };

    // Leave space for hidden pages at their last measured height. Pages around
    // the viewport are ready before scrolling reaches them.
    const tracker = new IntersectionObserver((entries) => {
      syncSelection();
      const selection = doc.getSelection();
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        const reading = element.contains(doc.activeElement) ||
          (!selectedPages.has(element) && !element.hasAttribute('data-work-history-placeholder') &&
            selection?.isCollapsed === false && selection.rangeCount > 0 &&
            selection.getRangeAt(0).intersectsNode(element));
        const height = entry.boundingClientRect.height;
        callbacks.current.get(element)?.setHeight(entry.isIntersecting || reading || height <= 0 ? null : height);
      }
    }, { root: viewport, rootMargin: '1200px 0px' });
    observer.current = tracker;
    for (const page of callbacks.current.keys()) tracker.observe(page);

    // A scrollbar jump can land beyond the observer's overscan. Restore only
    // the destination pages before painting instead of growing the buffer.
    let lastScrollTop = viewport.scrollTop;
    const restoreJump = () => {
      const distance = Math.abs(viewport.scrollTop - lastScrollTop);
      lastScrollTop = viewport.scrollTop;
      if (distance <= viewport.clientHeight) return;
      const bounds = viewport.getBoundingClientRect();
      const restore: HistoryPageVisibility[] = [];
      for (const [page, visibility] of callbacks.current) {
        if (!page.hasAttribute('data-work-history-placeholder')) continue;
        const rect = page.getBoundingClientRect();
        if (rect.bottom > bounds.top && rect.top < bounds.bottom) restore.push(visibility);
      }
      if (restore.length) flushSync(() => restore.forEach(page => page.setHeight(null)));
    };
    viewport.addEventListener('scroll', restoreJump, { passive: true });
    viewport.addEventListener('pointerdown', beginDrag, true);
    doc.addEventListener('selectionchange', syncSelection);
    doc.addEventListener('pointerup', finishDrag, true);
    doc.addEventListener('pointercancel', finishDrag, true);
    doc.defaultView?.addEventListener('blur', releaseDrag);
    return () => {
      viewport.removeEventListener('scroll', restoreJump);
      viewport.removeEventListener('pointerdown', beginDrag, true);
      doc.removeEventListener('selectionchange', syncSelection);
      doc.removeEventListener('pointerup', finishDrag, true);
      doc.removeEventListener('pointercancel', finishDrag, true);
      doc.defaultView?.removeEventListener('blur', releaseDrag);
      for (const page of selectedPages.values()) page.setSelected(false);
      tracker.disconnect();
      observer.current = null;
    };
  }, [keepAllMounted, measuredLayout]);

  const pages = [];
  const pageKeyOccurrences = new Map<string, number>();
  for (let index = 0; index < rows.length; index += ROWS_PER_PAGE) {
    const page = rows.slice(index, index + ROWS_PER_PAGE);
    const firstKey = rowKey(page[0], index);
    const occurrence = pageKeyOccurrences.get(firstKey) ?? 0;
    pageKeyOccurrences.set(firstKey, occurrence + 1);
    const rowKeys = JSON.stringify(page.map((row, offset) => rowKey(row, index + offset)));
    pages.push(
      <HistoryPage
        key={`${firstKey}:${occurrence}`}
        rowKeys={rowKeys}
        observe={observe}
        measuredLayout={measuredLayout}
        prepareSearch={prepareSearch}
        keepMounted={keepAllMounted || !measuredLayout || index + ROWS_PER_PAGE * 2 >= rows.length}
      >
        {page}
      </HistoryPage>
    );
  }
  return <div className="contents" ref={hostRef}>{pages}</div>;
}
