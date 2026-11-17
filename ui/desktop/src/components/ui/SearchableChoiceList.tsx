import { useState, type ReactNode } from 'react';
import { currentLocale } from '../../i18n';
import { selectNativeText } from '../../utils/nativeLocalization';
import { SHORT_LIST_LIMIT } from './SearchableSelect';

/** Keeps rich rows (for example checkboxes with model details) intact while filtering. */
export function SearchableChoiceList<T>({
  items,
  searchText,
  children,
}: {
  items: T[];
  searchText: (item: T) => string;
  children: (visible: T[]) => ReactNode;
}) {
  const [query, setQuery] = useState('');
  if (items.length <= SHORT_LIST_LIMIT) return <>{children(items)}</>;
  const needle = query.trim().toLocaleLowerCase();
  const visible = items.filter((item) => searchText(item).toLocaleLowerCase().includes(needle));
  const label = selectNativeText(currentLocale, 'Search models', '搜索模型', '搜尋模型');
  return (
    <div className="space-y-2">
      <input
        type="search"
        aria-label={label}
        placeholder={label}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="w-full rounded-md border border-border-primary bg-background-primary px-3 py-2 text-sm"
      />
      <div className="max-h-52 space-y-1 overflow-y-auto overscroll-contain">
        {visible.length ? (
          children(visible)
        ) : (
          <p role="status" className="p-2 text-sm text-text-secondary">
            {selectNativeText(currentLocale, 'No matches', '没有匹配项', '沒有符合項目')}
          </p>
        )}
      </div>
    </div>
  );
}
