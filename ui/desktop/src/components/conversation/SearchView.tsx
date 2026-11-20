import React, { useState, useEffect, PropsWithChildren, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import SearchBar from './SearchBar';
import { SearchHighlighter } from '../../utils/searchHighlighter';

/**
 * Props for the SearchView component
 */
interface SearchViewProps {
  /** Only the active surface responds to window-wide find commands. */
  active?: boolean;
  /** Optional CSS class name */
  className?: string;
  /** Render the search controls in the conversation header while retaining this search scope. */
  searchBarContainer?: HTMLElement | null;
  /** Optional callback for search term changes */
  onSearch?: (term: string, caseSensitive: boolean) => void;
  /** Exposes the search UI state to content that loads history on demand. */
  onVisibilityChange?: (visible: boolean) => void;
  /** Prepare conversation history only once a non-empty query needs it. */
  onQueryActiveChange?: (active: boolean) => void;
  /** Optional callback for navigating between search results */
  onNavigate?: (direction: 'next' | 'prev') => void;
  /** Current search results state */
  searchResults?: {
    count: number;
    currentIndex: number;
  } | null;
  /** Placeholder text for the search input */
  placeholder?: string;
  /** Show the case-sensitivity toggle (default: false). */
  showCaseSensitive?: boolean;
  /** Show the previous/next match navigation arrows (default: false). */
  showNavigation?: boolean;
  /** Highlight matches in the content via the find-in-page highlighter (default: true).
   * Set false when the search acts as a list filter, so the term only drives onSearch. */
  highlightMatches?: boolean;
}

interface SearchContainerElement extends HTMLDivElement {
  _searchHighlighter: SearchHighlighter | null;
}

/**
 * SearchView wraps content in a searchable container with a search bar that appears
 * when Cmd/Ctrl+F is pressed. Supports case-sensitive search and result navigation.
 * Features debounced search for better performance with large content.
 */
export const SearchView: React.FC<PropsWithChildren<SearchViewProps>> = ({
  active = true,
  className = '',
  searchBarContainer,
  children,
  onSearch,
  onVisibilityChange,
  onQueryActiveChange,
  onNavigate,
  searchResults,
  placeholder,
  showCaseSensitive = false,
  showNavigation = false,
  highlightMatches = true,
}) => {
  const [isSearchVisible, setIsSearchVisible] = useState(false);
  useEffect(() => {
    onVisibilityChange?.(isSearchVisible);
  }, [isSearchVisible, onVisibilityChange]);
  const [initialSearchTerm, setInitialSearchTerm] = useState('');
  const [searchPending, setSearchPending] = useState(false);
  const searchActiveInView = !onQueryActiveChange || active;
  const [internalSearchResults, setInternalSearchResults] = useState<{
    currentIndex: number;
    count: number;
  } | null>(null);

  const searchInputRef: React.RefObject<HTMLInputElement> = React.useRef<HTMLInputElement>(
    null
  ) as React.RefObject<HTMLInputElement>;
  const highlighterRef = React.useRef<SearchHighlighter | null>(null);
  const highlightFrame = useRef<number | undefined>(undefined);
  const containerRef = React.useRef<SearchContainerElement | null>(null);
  const clearSearch = useCallback(() => {
    if (highlightFrame.current !== undefined) cancelAnimationFrame(highlightFrame.current);
    highlightFrame.current = undefined;
    highlighterRef.current?.destroy();
    highlighterRef.current = null;
  }, []);

  /**
   * Handles the search operation when a user enters a search term.
   * Uses debouncing to prevent excessive highlighting operations.
   * @param term - The text to search for
   * @param caseSensitive - Whether to perform a case-sensitive search
   */
  const handleSearch = useCallback(
    (term: string, caseSensitive: boolean) => {
      if (!searchActiveInView) return;
      onSearch?.(term, caseSensitive);

      // When highlighting is disabled (search acts as a list filter), the term only drives
      // onSearch — skip all find-in-page highlighter machinery.
      if (!highlightMatches) {
        return;
      }

      clearSearch();
      setInternalSearchResults(null);
      onQueryActiveChange?.(Boolean(term.trim()));
      const container = containerRef.current;
      setSearchPending(Boolean(container && term.trim() && onQueryActiveChange));
      if (!container || !term.trim()) return;

      const highlighter = new SearchHighlighter(container, (count) => {
        setInternalSearchResults(count > 0 ? { currentIndex: 1, count } : null);
      });
      highlighterRef.current = highlighter;
      const performHighlight = () => {
        highlightFrame.current = undefined;
        if (container.querySelector('[data-work-history-search-pending]')) {
          highlightFrame.current = requestAnimationFrame(performHighlight);
          return;
        }
        void highlighter.highlight(term, caseSensitive).then((count) => {
          if (count === undefined || highlighterRef.current !== highlighter) return;
          setInternalSearchResults(count > 0 ? { currentIndex: 1, count } : null);
          if (count > 0) highlighter.setCurrentMatch(0, true);
          setSearchPending(false);
        });
      };
      // Wait for the parent to enable history preparation and then preserve the
      // existing document search over complete results.
      if (onQueryActiveChange) highlightFrame.current = requestAnimationFrame(performHighlight);
      else performHighlight();
    },
    [clearSearch, onSearch, highlightMatches, onQueryActiveChange, searchActiveInView]
  );

  /**
   * Navigates between search results in the specified direction.
   * @param direction - Direction to navigate ('next' or 'prev')
   */
  const handleNavigate = useCallback(
    (direction: 'next' | 'prev') => {
      // If external navigation is provided, use that
      if (onNavigate) {
        onNavigate(direction);
        return;
      }

      // Otherwise use internal navigation
      if (!internalSearchResults || !highlighterRef.current) return;

      let newIndex: number;
      if (direction === 'next') {
        newIndex = (internalSearchResults.currentIndex % internalSearchResults.count) + 1;
      } else {
        newIndex =
          internalSearchResults.currentIndex === 1
            ? internalSearchResults.count
            : internalSearchResults.currentIndex - 1;
      }

      setInternalSearchResults({
        ...internalSearchResults,
        currentIndex: newIndex,
      });

      highlighterRef.current.setCurrentMatch(newIndex - 1, true);
    },
    [internalSearchResults, onNavigate]
  );

  // Create stable refs for the handlers to avoid memory leaks
  const handlersRef = useRef({
    handleFindCommand: () => {
      if (isSearchVisible && searchInputRef.current) {
        searchInputRef.current.focus();
        searchInputRef.current.select();
      } else {
        setIsSearchVisible(true);
      }
    },
    handleFindNext: () => {
      if (isSearchVisible) {
        handleNavigate('next');
      }
    },
    handleFindPrevious: () => {
      if (isSearchVisible) {
        handleNavigate('prev');
      }
    },
    handleUseSelectionFind: () => {
      const selection = window.getSelection()?.toString().trim();
      if (selection) {
        setInitialSearchTerm(selection);
      }
    },
  });

  // Update the refs with current values
  useEffect(() => {
    handlersRef.current.handleFindCommand = () => {
      if (isSearchVisible && searchInputRef.current) {
        searchInputRef.current.focus();
        searchInputRef.current.select();
      } else {
        setIsSearchVisible(true);
      }
    };
    handlersRef.current.handleFindNext = () => {
      if (isSearchVisible) {
        handleNavigate('next');
      }
    };
    handlersRef.current.handleFindPrevious = () => {
      if (isSearchVisible) {
        handleNavigate('prev');
      }
    };
    handlersRef.current.handleUseSelectionFind = () => {
      const selection = window.getSelection()?.toString().trim();
      if (selection) {
        setInitialSearchTerm(selection);
      }
    };
  });

  const handleFindCommand = useCallback(() => {
    handlersRef.current.handleFindCommand();
  }, []);

  const handleFindNext = useCallback(() => {
    handlersRef.current.handleFindNext();
  }, []);

  const handleFindPrevious = useCallback(() => {
    handlersRef.current.handleFindPrevious();
  }, []);

  const releaseSearchHistory = useCallback(() => {
    clearSearch();
    onQueryActiveChange?.(false);
  }, [clearSearch, onQueryActiveChange]);

  useEffect(() => {
    if (searchActiveInView) return;
    releaseSearchHistory();
    setSearchPending(false);
    setInternalSearchResults(null);
  }, [releaseSearchHistory, searchActiveInView]);

  const handleUseSelectionFind = useCallback(() => {
    handlersRef.current.handleUseSelectionFind();
  }, []);

  /**
   * Closes the search interface and cleans up highlights.
   */
  const handleCloseSearch = useCallback(() => {
    setIsSearchVisible(false);
    setInternalSearchResults(null);
    setSearchPending(false);

    releaseSearchHistory();
    // Clear search when closing
    onSearch?.('', false);
  }, [releaseSearchHistory, onSearch]);

  // Clean up highlighter on unmount
  useEffect(() => clearSearch, [clearSearch]);

  // Listen for keyboard events
  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = window.electron.platform === 'darwin';

      // Handle ⌘F/Ctrl+F to show/focus search
      if ((isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && e.key === 'f') {
        e.preventDefault();
        if (isSearchVisible && searchInputRef.current) {
          // If search is already visible, focus and select the input
          searchInputRef.current.focus();
          searchInputRef.current.select();
        } else {
          // Otherwise show the search UI
          setIsSearchVisible(true);
        }
        return;
      }

      // Handle ⌘E to use selection for find (Mac only)
      if (isMac && e.metaKey && !e.shiftKey && e.key === 'e') {
        // Don't handle ⌘E if we're in the search input - let the native behavior work
        if (e.target instanceof HTMLInputElement && e.target.id === 'search-input') {
          return;
        }

        e.preventDefault();
        handleUseSelectionFind();
        return;
      }

      // Only handle ⌘G and ⇧⌘G if search is visible (Mac only)
      if (isSearchVisible && isMac && e.metaKey && e.key === 'g') {
        e.preventDefault();
        if (e.shiftKey) {
          // ⇧⌘G - Find Previous
          handleNavigate('prev');
        } else {
          // ⌘G - Find Next
          handleNavigate('next');
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [active, isSearchVisible, handleNavigate, handleSearch, handleUseSelectionFind]);

  // Listen for Find menu commands
  useEffect(() => {
    if (!active) return;
    window.electron.on('find-command', handleFindCommand);
    window.electron.on('find-next', handleFindNext);
    window.electron.on('find-previous', handleFindPrevious);
    window.electron.on('use-selection-find', handleUseSelectionFind);

    return () => {
      window.electron.off('find-command', handleFindCommand);
      window.electron.off('find-next', handleFindNext);
      window.electron.off('find-previous', handleFindPrevious);
      window.electron.off('use-selection-find', handleUseSelectionFind);
    };
  }, [active, handleFindCommand, handleFindNext, handleFindPrevious, handleUseSelectionFind]);

  const searchBar = isSearchVisible ? (
    <SearchBar
      active={searchActiveInView}
      onSearch={handleSearch}
      onClose={handleCloseSearch}
      onCloseStart={onQueryActiveChange ? releaseSearchHistory : undefined}
      onNavigate={handleNavigate}
      searchResults={searchResults || internalSearchResults || undefined}
      searchPending={searchPending}
      inputRef={searchInputRef}
      initialSearchTerm={initialSearchTerm}
      placeholder={placeholder}
      showCaseSensitive={showCaseSensitive}
      showNavigation={showNavigation}
      inHeader={!!searchBarContainer}
    />
  ) : null;

  return (
    <div
      ref={(el) => {
        if (el) {
          containerRef.current = el as SearchContainerElement;
          // Expose the highlighter instance
          containerRef.current._searchHighlighter = highlighterRef.current;
        }
      }}
      className={`search-container ${className}`}
    >
      {searchBarContainer ? createPortal(searchBar, searchBarContainer) : searchBar}
      {children}
    </div>
  );
};
