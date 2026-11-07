import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ToolboxItem } from '../../types/toolbox';
import { useIntl } from '../../i18n';
import { selectNativeText } from '../../utils/nativeLocalization';
import { Button } from '../ui/button';

const PAGE_SIZE = 24;

// Keep the searchable inventory complete; mount cards only as the user scrolls.
// The button also works with a keyboard or without IntersectionObserver.
export function ProgressiveToolboxGrid({ entries, renderItem }: {
  entries: ToolboxItem[];
  renderItem: (item: ToolboxItem) => ReactNode;
}) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const sentinel = useRef<HTMLDivElement>(null);
  const intl = useIntl();
  const hasMore = limit < entries.length;
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        observer.disconnect();
        setLimit(value => value + PAGE_SIZE);
      }
    }, { root: target.closest('[data-toolbox-scroll]'), rootMargin: '200px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, limit, entries.length]);
  return <>
    <div className="grid gap-3 lg:grid-cols-2">
      {entries.slice(0, limit).map(renderItem)}
    </div>
    {hasMore && <div ref={sentinel} className="mt-3 flex items-center gap-3">
      <Button variant="outline" onClick={() => setLimit(value => value + PAGE_SIZE)}>
        {selectNativeText(intl.locale, 'Load more', '加载更多', '載入更多')}
      </Button>
      <span className="text-xs text-text-muted">{Math.min(limit, entries.length)} / {entries.length}</span>
    </div>}
  </>;
}
