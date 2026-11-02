import React, { useEffect, useState, useRef, KeyboardEvent } from 'react';
import { defineMessages, useIntl } from '../../i18n';
import { Search as SearchIcon } from 'lucide-react';
import { ArrowDown, ArrowUp, Close } from '../icons';
import debounce from 'lodash/debounce';
import { Button } from '../ui/button';
import { cn } from '../../utils';

const i18nMessages = defineMessages({
  defaultPlaceholder: {
    id: 'searchBar.placeholder',
    defaultMessage: 'Search conversation...',
  },
  caseSensitive: {
    id: 'searchBar.caseSensitive',
    defaultMessage: 'Case Sensitive',
  },
  previous: {
    id: 'searchBar.previous',
    defaultMessage: 'Previous ({shortcut})',
  },
  next: {
    id: 'searchBar.next',
    defaultMessage: 'Next ({shortcut})',
  },
  close: {
    id: 'searchBar.close',
    defaultMessage: 'Close ({shortcut})',
  },
});

/**
 * Props for the SearchBar component
 */
interface SearchBarProps {
  /** Callback fired when search term or case sensitivity changes */
  onSearch: (term: string, caseSensitive: boolean) => void;
  /** Callback fired when the search bar is closed */
  onClose: () => void;
  /** Optional callback for navigating between search results */
  onNavigate?: (direction: 'next' | 'prev') => void;
  /** Current search results state */
  searchResults?: {
    count: number;
    currentIndex: number;
  };
  /** Optional ref for the search input element */
  inputRef?: React.RefObject<HTMLInputElement>;
  /** Initial search term */
  initialSearchTerm?: string;
  /** Placeholder text for the search input */
  placeholder?: string;
  /** Show the case-sensitivity toggle (default: false). */
  showCaseSensitive?: boolean;
  /** Show the previous/next match navigation arrows (default: false). When hidden, the
   * result counter shows the total instead of "current/total". */
  showNavigation?: boolean;
  /** Fit the search input within the conversation title row. */
  inHeader?: boolean;
}

/**
 * SearchBar provides a search input with case-sensitive toggle and result navigation.
 */
export const SearchBar: React.FC<SearchBarProps> = ({
  onSearch,
  onClose,
  onNavigate,
  searchResults,
  inputRef: externalInputRef,
  initialSearchTerm = '',
  placeholder,
  showCaseSensitive = false,
  showNavigation = false,
  inHeader = false,
}: SearchBarProps) => {
  const intl = useIntl();
  const resolvedPlaceholder = placeholder ?? intl.formatMessage(i18nMessages.defaultPlaceholder);
  const [searchTerm, setSearchTerm] = useState(initialSearchTerm);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const internalInputRef = React.useRef<HTMLInputElement>(null);
  const inputRef = externalInputRef || internalInputRef;
  const debouncedSearchRef = useRef<ReturnType<typeof debounce> | null>(null);

  // Create debounced search function
  useEffect(() => {
    const debouncedFn = debounce((term: string, caseSensitive: boolean) => {
      onSearch(term, caseSensitive);
    }, 200);

    debouncedSearchRef.current = debouncedFn;

    return () => {
      debouncedFn.cancel();
    };
  }, [onSearch]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [inputRef]);

  // Handle changes to initialSearchTerm
  useEffect(() => {
    if (initialSearchTerm) {
      setSearchTerm(initialSearchTerm);
      debouncedSearchRef.current?.(initialSearchTerm, caseSensitive);
    }
  }, [initialSearchTerm, caseSensitive, debouncedSearchRef]);

  const [localSearchResults, setLocalSearchResults] = useState<typeof searchResults>(undefined);

  // Sync external search results with local state
  useEffect(() => {
    // Only set results if we have a search term
    if (!searchTerm) {
      setLocalSearchResults(undefined);
    } else {
      setLocalSearchResults(searchResults);
    }
  }, [searchResults, searchTerm]);

  const handleSearch = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;

    // Always cancel pending searches first
    if (debouncedSearchRef.current) {
      debouncedSearchRef.current.cancel();
    }

    // Update display term immediately for UI feedback
    setSearchTerm(value);

    if (value.length > 0) {
      debouncedSearchRef.current?.(value, caseSensitive);
    } else {
      onSearch('', caseSensitive);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowUp') {
      handleNavigate('prev', event);
    } else if (event.key === 'ArrowDown' || event.key === 'Enter') {
      handleNavigate('next', event);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      handleClose();
    }
  };

  const handleNavigate = (direction: 'next' | 'prev', e?: React.MouseEvent | KeyboardEvent) => {
    e?.preventDefault();
    if (searchResults && searchResults.count > 0) {
      inputRef.current?.focus();
      onNavigate?.(direction);
    }
  };

  const toggleCaseSensitive = () => {
    const newCaseSensitive = !caseSensitive;
    setCaseSensitive(newCaseSensitive);
    // Immediately trigger a new search with updated case sensitivity
    if (searchTerm) {
      debouncedSearchRef.current?.(searchTerm, newCaseSensitive);
    }
    inputRef.current?.focus();
  };

  const handleClose = () => {
    setIsExiting(true);
    debouncedSearchRef.current?.cancel(); // Cancel any pending searches
    setTimeout(() => {
      onClose();
    }, 150); // Match animation duration
  };

  const hasResults = searchResults && searchResults.count > 0;

  return (
    <div
      className={cn(
        'search-bar z-30 w-full max-w-md text-text-primary',
        inHeader ? 'relative h-9 transition-opacity duration-150' : 'sticky top-0 mb-4',
        inHeader ? isExiting && 'opacity-0' : isExiting ? 'search-bar-exit' : 'search-bar-enter'
      )}
    >
      <div
        className={`rounded-xl bg-background-secondary shadow-[0_4px_18px_rgba(0,0,0,0.12)] ${inHeader ? 'absolute inset-x-0 top-0' : ''}`}
      >
        <div className="flex h-9 items-center gap-2 px-3">
          <SearchIcon aria-hidden="true" className="no-drag h-4 w-4 shrink-0" />
          <input
            ref={inputRef}
            id="search-input"
            type="text"
            value={searchTerm}
            onChange={handleSearch}
            onKeyDown={handleKeyDown}
            placeholder={resolvedPlaceholder}
            aria-label={resolvedPlaceholder}
            className="no-drag h-full min-w-0 flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-secondary focus:outline-none"
          />
          <div className="flex shrink-0 items-center gap-1">
            {showCaseSensitive && (
              <Button
                onClick={toggleCaseSensitive}
                variant="ghost"
                size="sm"
                shape="round"
                className={`no-drag ${
                  caseSensitive
                    ? 'bg-background-tertiary text-text-primary'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
                title={intl.formatMessage(i18nMessages.caseSensitive)}
              >
                <span className="text-md font-normal">Aa</span>
              </Button>
            )}

            <div className="ml-1">
              <Button
                onClick={handleClose}
                variant="ghost"
                size="xs"
                shape="round"
                className="no-drag text-text-primary hover:bg-background-tertiary"
                aria-label={intl.formatMessage(i18nMessages.close, { shortcut: 'Esc' })}
                title={intl.formatMessage(i18nMessages.close, { shortcut: 'Esc' })}
              >
                <Close className="h-5 w-5" />
              </Button>
            </div>
          </div>
        </div>
        {showNavigation && searchTerm.length > 0 && (
          <div className="search-results flex h-8 items-center gap-1 px-2 pb-1">
            <Button
              onClick={(event) => handleNavigate('prev', event)}
              variant="ghost"
              size="xs"
              shape="round"
              disabled={!hasResults}
              aria-label={intl.formatMessage(i18nMessages.previous, { shortcut: '↑' })}
              title={intl.formatMessage(i18nMessages.previous, { shortcut: '↑' })}
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
            <Button
              onClick={(event) => handleNavigate('next', event)}
              variant="ghost"
              size="xs"
              shape="round"
              disabled={!hasResults}
              aria-label={intl.formatMessage(i18nMessages.next, { shortcut: '↓ or Enter' })}
              title={intl.formatMessage(i18nMessages.next, { shortcut: '↓ or Enter' })}
            >
              <ArrowDown className="h-4 w-4" />
            </Button>
            <output
              aria-live="polite"
              className="ml-auto pr-2 text-xs text-text-secondary tabular-nums"
            >
              {localSearchResults?.count ? localSearchResults.currentIndex : 0} /{' '}
              {localSearchResults?.count ?? 0}
            </output>
          </div>
        )}
      </div>
    </div>
  );
};

export default SearchBar;
