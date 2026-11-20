import '../styles/search-highlights.css';

function documentHighlight(name: string, priority: number) {
  const registry = window.CSS?.highlights;
  if (!registry || typeof window.Highlight !== 'function') return;
  const existing = registry.get(name);
  if (existing) return existing;

  const highlight = new window.Highlight();
  highlight.priority = priority;
  registry.set(name, highlight);
  return highlight;
}

/** Finds rendered text and lets Chromium paint the matching ranges. */
export class SearchHighlighter {
  private readonly matches = documentHighlight('conversation-find', 0);
  private readonly current = documentHighlight('conversation-find-current', 1);
  private readonly mutations: MutationObserver;
  private readonly scrollContainer: HTMLElement | null;
  private ranges: ReturnType<typeof document.createRange>[] = [];
  private currentMatchIndex = -1;
  private term = '';
  private caseSensitive = false;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private frame?: number;
  private completeSearch?: (count?: number) => void;
  private refreshAfterSearch = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly onMatchesChange?: (count: number) => void
  ) {
    const scope = container.closest<HTMLElement>('[data-search-scroll-area]');
    this.scrollContainer = scope?.querySelector('[data-radix-scroll-area-viewport]') ??
      scope ?? container.closest('[data-radix-scroll-area-viewport]');

    this.mutations = new MutationObserver(records => {
      if (records.some(({ target }) => {
        const element = target instanceof HTMLElement ? target : target.parentElement;
        return !element?.closest('.search-bar, .search-results');
      })) this.refresh();
    });
    this.mutations.observe(container, { childList: true, characterData: true, subtree: true });
  }

  private refresh() {
    if (!this.term) return;
    if (this.completeSearch) {
      this.refreshAfterSearch = true;
      return;
    }
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      if (this.completeSearch) this.refreshAfterSearch = true;
      else void this.highlight(this.term, this.caseSensitive);
    }, 100);
  }

  highlight(term: string, caseSensitive = false): Promise<number | undefined> {
    const oldCount = this.ranges.length;
    const oldIndex = this.currentMatchIndex;
    this.cancel();
    this.clearRanges();
    this.term = term;
    this.caseSensitive = caseSensitive;
    if (!term.trim()) return Promise.resolve(0);

    const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');
    const walker = document.createTreeWalker(this.container, NodeFilter.SHOW_TEXT, {
      acceptNode: node => node.parentElement?.closest('.search-bar, .search-results')
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    let node = walker.nextNode() as Text | null;
    const scan = () => {
      this.frame = undefined;
      const deadline = window.performance.now() + 7;
      while (node && window.performance.now() < deadline) {
        const match = regex.exec(node.data);
        if (!match) {
          node = walker.nextNode() as Text | null;
          continue;
        }
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, regex.lastIndex);
        this.ranges.push(range);
        this.matches?.add(range);
      }
      if (node) {
        this.frame = requestAnimationFrame(scan);
        return;
      }

      const complete = this.completeSearch;
      this.completeSearch = undefined;
      const count = this.ranges.length;
      if (count !== oldCount) this.onMatchesChange?.(count);
      if (count) this.setCurrentMatch(count === oldCount && oldIndex >= 0 ? oldIndex : 0, false);
      complete?.(count);
      if (this.refreshAfterSearch) {
        this.refreshAfterSearch = false;
        this.refresh();
      }
    };
    return new Promise(resolve => {
      this.completeSearch = resolve;
      this.frame = requestAnimationFrame(scan);
    });
  }

  setCurrentMatch(index: number, shouldScroll = true) {
    const count = this.ranges.length;
    if (!count) return;
    const previous = this.ranges[this.currentMatchIndex];
    if (previous) this.current?.delete(previous);
    this.currentMatchIndex = ((index % count) + count) % count;
    const match = this.ranges[this.currentMatchIndex];
    this.current?.add(match);

    if (!shouldScroll || !this.scrollContainer || typeof match.getBoundingClientRect !== 'function') return;
    const bounds = match.getBoundingClientRect();
    if (!bounds.height) return;
    const viewport = this.scrollContainer.getBoundingClientRect();
    this.scrollContainer.scrollTop += bounds.top - viewport.top - (viewport.height - bounds.height) / 2;
  }

  private clearRanges() {
    const current = this.ranges[this.currentMatchIndex];
    if (current) this.current?.delete(current);
    if (this.matches?.size === this.ranges.length) this.matches.clear();
    else for (const range of this.ranges) this.matches?.delete(range);
    this.ranges = [];
    this.currentMatchIndex = -1;
  }

  private cancel() {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.completeSearch?.();
    this.completeSearch = undefined;
    this.refreshAfterSearch = false;
  }

  destroy() {
    clearTimeout(this.refreshTimer);
    this.mutations.disconnect();
    this.cancel();
    this.clearRanges();
  }
}
