import { composerCommandItems } from './composerCommands';
import { createPortal } from 'react-dom';
import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { ItemIcon } from './ItemIcon';
import { getInitialWorkingDir } from '../utils/workingDir';
import { defineMessages, useIntl } from '../i18n';
import { listAgentMentionItems, listSlashCommandItems } from '../acp/autocomplete';
import { loadToolbox, type ToolboxLoadResult } from '../acp/toolbox';
import { localizeToolboxItem } from './toolbox/toolboxLocalization';
import type { ToolboxItem } from '../types/toolbox';
import { acpListSessions } from '../acp/sessions';
import { conversationMention } from './conversationMention';

const i18n = defineMessages({
  files: { id: 'mentionPopover.files', defaultMessage: 'Files and folders' },
  conversations: { id: 'mentionPopover.conversations', defaultMessage: 'Conversations' },
  agents: { id: 'mentionPopover.agents', defaultMessage: 'Agents' },
  loading: { id: 'mentionPopover.loading', defaultMessage: 'Searching…' },
  failed: {
    id: 'mentionPopover.failed',
    defaultMessage: 'Some results could not be loaded. Reopen the menu to retry.',
  },
  chooseProject: {
    id: 'mentionPopover.chooseProject',
    defaultMessage:
      'Select a project to reference its files. You can still reference a conversation.',
  },
  empty: { id: 'mentionPopover.empty', defaultMessage: 'No files or conversations found.' },
  more: {
    id: 'mentionPopover.more',
    defaultMessage: 'More results are available. Type a more specific name.',
  },
  keys: { id: 'mentionPopover.keys', defaultMessage: '↑ ↓ Select · Enter Insert · Esc Close' },
  addGroup: { id: 'mentionPopover.addGroup', defaultMessage: 'Add' },
  loadMore: { id: 'mentionPopover.loadMore', defaultMessage: 'Load more' },
  commandGroup: { id: 'mentionPopover.commandGroup', defaultMessage: 'Commands' },
  skillGroup: { id: 'mentionPopover.skillGroup', defaultMessage: 'Skills' },
  recipeGroup: { id: 'mentionPopover.recipeGroup', defaultMessage: 'Saved tasks' },
  mcpGroup: { id: 'mentionPopover.mcpGroup', defaultMessage: 'MCP servers' },
  toolsGroup: { id: 'mentionPopover.toolsGroup', defaultMessage: 'Built-in tools' },
  disabled: { id: 'mentionPopover.disabled', defaultMessage: 'Disabled' },
  inventoryHint: { id: 'mentionPopover.inventoryHint', defaultMessage: 'Use in this conversation' },
  inventoryFailed: {
    id: 'mentionPopover.inventoryFailed',
    defaultMessage: 'Some Toolbox entries could not be loaded. Reopen the menu to retry.',
  },
  scanningFiles: {
    id: 'mentionPopover.scanningFiles',
    defaultMessage: 'Scanning files...',
  },
  loadingCommands: {
    id: 'mentionPopover.loadingCommands',
    defaultMessage: 'Loading commands...',
  },
  itemsFound: {
    id: 'mentionPopover.itemsFound',
    defaultMessage: '{count, plural, one {# item} other {# items}} found',
  },
  noItemsFound: {
    id: 'mentionPopover.noItemsFound',
    defaultMessage: 'No items found matching "{query}"',
  },
  noCommandsFound: {
    id: 'mentionPopover.noCommandsFound',
    defaultMessage: 'No commands found matching "{query}"',
  },
});

type CommandItemType = 'Builtin' | 'Recipe' | 'Skill' | 'Agent';
type DisplayItemType = CommandItemType | 'Directory' | 'File' | 'Mcp' | 'Tool' | 'Conversation';

const typeOrder: Record<DisplayItemType, number> = {
  Agent: 0,
  Directory: 1,
  File: 2,
  Builtin: 3,
  Skill: 4,
  Recipe: 5,
  Mcp: 6,
  Tool: 7,
  Conversation: 8,
};

export interface DisplayItem {
  name: string;
  extra: string;
  itemType: DisplayItemType;
  relativePath: string;
  insertText?: string;
  commandGroup?: 'add' | 'control';
  commandOrder?: number;
  toolboxItem?: ToolboxItem;
  updatedAt?: string;
}

const mentionGroup = (item: DisplayItem) =>
  item.itemType === 'Conversation' ? 1 : item.itemType === 'Agent' ? 2 : 0;
const mentionGroupLabels = [i18n.files, i18n.conversations, i18n.agents];

export interface DisplayItemWithMatch extends DisplayItem {
  matchScore: number;
  matches: number[];
  matchedText: string;
}

const commandGroup = (item: DisplayItem) =>
  item.commandGroup === 'add'
    ? 0
    : item.itemType === 'Builtin'
      ? 1
      : item.itemType === 'Skill'
        ? 2
        : item.itemType === 'Mcp'
          ? 3
          : item.itemType === 'Tool'
            ? 4
            : 5;
const groupLabels = [
  i18n.addGroup,
  i18n.commandGroup,
  i18n.skillGroup,
  i18n.mcpGroup,
  i18n.toolsGroup,
  i18n.recipeGroup,
];

interface MentionPopoverProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (filePath: string, item?: DisplayItem) => void;
  anchorRef: RefObject<HTMLElement | null>;
  query: string;
  isSlashCommand: boolean;
  addOnly?: boolean;
  selectedIndex: number;
  onSelectedIndexChange: (index: number) => void;
  workingDir?: string;
  sessionId?: string | null;
}

// Enhanced fuzzy matching algorithm
const fuzzyMatch = (pattern: string, text: string): { score: number; matches: number[] } => {
  if (!pattern) return { score: 0, matches: [] };

  const patternLower = pattern.toLowerCase();
  const textLower = text.toLowerCase();
  const matches: number[] = [];

  let patternIndex = 0;
  let score = 0;
  let consecutiveMatches = 0;

  for (let i = 0; i < textLower.length && patternIndex < patternLower.length; i++) {
    if (textLower[i] === patternLower[patternIndex]) {
      matches.push(i);
      patternIndex++;
      consecutiveMatches++;

      // Bonus for consecutive matches
      score += consecutiveMatches * 3;

      // Bonus for matches at word boundaries or path separators
      if (
        i === 0 ||
        textLower[i - 1] === '/' ||
        textLower[i - 1] === '_' ||
        textLower[i - 1] === '-' ||
        textLower[i - 1] === '.'
      ) {
        score += 10;
      }

      // Bonus for matching the start of the filename (after last /)
      const lastSlash = textLower.lastIndexOf('/', i);
      if (lastSlash !== -1 && i === lastSlash + 1) {
        score += 15;
      }
    } else {
      consecutiveMatches = 0;
    }
  }

  // Only return a score if all pattern characters were matched
  if (patternIndex === patternLower.length) {
    // Less penalty for longer strings to allow nested files to rank well
    score -= text.length * 0.05;

    // Bonus for exact substring matches
    if (textLower.includes(patternLower)) {
      score += 20;
    }

    // Bonus for matching the filename specifically (not just the path)
    const fileName = text.split('/').pop()?.toLowerCase() || '';
    if (fileName.includes(patternLower)) {
      score += 25;
    }

    return { score, matches };
  }

  return { score: -1, matches: [] };
};

const MentionPopover = forwardRef<
  { getDisplayFiles: () => DisplayItemWithMatch[]; selectFile: (index: number) => void },
  MentionPopoverProps
>(
  (
    {
      isOpen,
      onClose,
      onSelect,
      anchorRef,
      query,
      isSlashCommand,
      addOnly = false,
      selectedIndex,
      onSelectedIndexChange,
      workingDir,
      sessionId,
    },
    ref
  ) => {
    const intl = useIntl();
    const [items, setItems] = useState<DisplayItem[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [inventoryError, setInventoryError] = useState(false);
    const [inventoryRequested, setInventoryRequested] = useState(false);
    // Presentation cache only: selecting a tool still validates/loads it through
    // the normal chat flow. Scope changes never reuse another project's menu.
    const inventoryCache = useRef<{ key: string; commands: DisplayItem[]; inventory: DisplayItem[] } | null>(null);
    const [visibleLimit, setVisibleLimit] = useState(20);
    const lastScrolledIndex = useRef<number | null>(null);
    useEffect(() => {
      setInventoryRequested(false);
      setVisibleLimit(20);
      lastScrolledIndex.current = null;
    }, [isOpen, workingDir, sessionId, addOnly]);
    const popoverRef = useRef<HTMLDivElement>(null);
    const [initialHeight, setInitialHeight] = useState<number | null>(null);
    const [position, setPosition] = useState<{ x: number; y: number; width: number } | null>(null);
    useLayoutEffect(() => {
      if (!isOpen) return;
      let frame = 0;
      // Follow the textarea through window and pane transitions, including moves
      // that don't resize the textarea itself. Only publish changed geometry.
      const measure = () => {
        const anchor = anchorRef.current;
        if (anchor) {
          const { left: x, top: y, width } = anchor.getBoundingClientRect();
          setPosition((previous) =>
            previous?.x === x && previous.y === y && previous.width === width
              ? previous
              : { x, y, width }
          );
        }
        frame = requestAnimationFrame(measure);
      };
      measure();
      return () => cancelAnimationFrame(frame);
    }, [isOpen, anchorRef]);
    const listRef = useRef<HTMLDivElement>(null);
    const currentWorkingDir = workingDir ?? getInitialWorkingDir();
    const draftScope = useMemo(
      () => ({ sessionId: `mention-${globalThis.crypto.randomUUID()}`, root: currentWorkingDir }),
      [currentWorkingDir]
    );

    const [mentionError, setMentionError] = useState(false);
    const [truncated, setTruncated] = useState(false);

    useEffect(() => {
      if (!isOpen || isSlashCommand) return;
      let cancelled = false;
      setItems([]);
      setIsLoading(true);
      setMentionError(false);
      setTruncated(false);
      const timer = setTimeout(() => {
        let files: DisplayItem[] = [],
          conversations: DisplayItem[] = [],
          agents: DisplayItem[] = [];
        const publish = () => {
          if (!cancelled) setItems([...files, ...conversations, ...agents]);
        };
        const failed = () => {
          if (!cancelled) setMentionError(true);
        };
        const tasks = [
          acpListSessions(null, { keyword: query }, 'unified')
            .then((page) => {
              conversations = page.sessions
                .filter(
                  (session) =>
                    session.id !== sessionId && session.messageCount > 0 && !session.archivedAt
                )
                .map((session) => ({
                  name: session.name,
                  extra: session.workingDir,
                  relativePath: session.id,
                  itemType: 'Conversation' as const,
                  updatedAt: session.updatedAt,
                  insertText: conversationMention(session.id, session.name),
                }));
              if (!cancelled && (page.nextCursor || conversations.length > 20)) setTruncated(true);
              conversations = conversations.slice(0, 20);
              publish();
            })
            .catch(failed),
        ];
        if (currentWorkingDir.trim()) {
          tasks.push(
            window.electron
              .workspacePanel({
                scope: sessionId ? { sessionId, root: currentWorkingDir } : draftScope,
                ...(query.trim()
                  ? { action: 'search' as const, query }
                  : { action: 'list' as const, path: '' }),
              })
              .then((result) => {
                const entries = (result.entries ?? []).filter(
                  (entry) =>
                    !(
                      entry.kind === 'directory' &&
                      ['.git', 'node_modules', 'target', '.venv'].includes(entry.name)
                    )
                );
                const limit = query.trim() ? 40 : 8;
                files = entries.slice(0, limit).map((entry) => ({
                  name: entry.name,
                  relativePath: entry.path,
                  extra: entry.path,
                  itemType: entry.kind === 'directory' ? ('Directory' as const) : ('File' as const),
                  insertText:
                    JSON.stringify(
                      currentWorkingDir.replace(/\\/g, '/').replace(/\/+$/, '') +
                        '/' +
                        entry.path.replace(/\\/g, '/')
                    ) + ' ',
                }));
                if (!cancelled && (result.truncated || entries.length > limit)) setTruncated(true);
                publish();
              })
              .catch(failed)
          );
          tasks.push(
            listAgentMentionItems(currentWorkingDir, sessionId ?? undefined)
              .then((result) => {
                agents = result;
                publish();
              })
              .catch(failed)
          );
        }
        void Promise.allSettled(tasks).then(() => {
          if (!cancelled) setIsLoading(false);
        });
      }, 180);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }, [isOpen, isSlashCommand, currentWorkingDir, draftScope, sessionId, query]);

    const compareByType = (a: DisplayItemWithMatch, b: DisplayItemWithMatch) => {
      const orderA = typeOrder[a.itemType] ?? Number.MAX_SAFE_INTEGER;
      const orderB = typeOrder[b.itemType] ?? Number.MAX_SAFE_INTEGER;
      return orderA - orderB;
    };

    const availableItems = useMemo(
      () =>
        addOnly
          ? (items.length ? items : composerCommandItems(intl)).filter((item) => item.itemType !== 'Builtin' || item.commandGroup === 'add')
          : items,
      [items, addOnly, intl]
    );
    const displayItems = useMemo((): DisplayItemWithMatch[] => {
      if (!query.trim()) {
        return availableItems
          .map((file) => ({
            ...file,
            matchScore: 0,
            matches: [],
            matchedText: file.name,
            depth: currentWorkingDir
              ? file.extra.replace(currentWorkingDir, '').split('/').length - 1
              : 0,
          }))
          .sort((a, b) => {
            if (!isSlashCommand && mentionGroup(a) !== mentionGroup(b))
              return mentionGroup(a) - mentionGroup(b);
            if (a.itemType === 'Conversation' && b.itemType === 'Conversation')
              return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
            if (isSlashCommand && commandGroup(a) !== commandGroup(b))
              return commandGroup(a) - commandGroup(b);
            if (isSlashCommand && a.commandOrder !== undefined && b.commandOrder !== undefined)
              return a.commandOrder - b.commandOrder;
            if (a.depth !== b.depth) return a.depth - b.depth;
            const typeComparison = compareByType(a, b);
            return typeComparison || a.name.localeCompare(b.name);
          });
      }

      return availableItems
        .map((file) => {
          const matches = [
            { match: fuzzyMatch(query, file.name), text: file.name },
            { match: fuzzyMatch(query, file.relativePath), text: file.relativePath },
            { match: fuzzyMatch(query, file.extra), text: file.extra },
            ...(isSlashCommand && file.toolboxItem
              ? [
                  {
                    match: fuzzyMatch(query, intl.formatMessage(groupLabels[commandGroup(file)])),
                    text: file.name,
                  },
                ]
              : []),
          ];

          const { match: bestMatch, text: matchedText } = matches.reduce((best, current) =>
            current.match.score > best.match.score ? current : best
          );

          let finalScore = bestMatch.score;
          if (finalScore > 0 && file.itemType === 'Agent') {
            finalScore += 100;
          } else if (finalScore > 0 && currentWorkingDir) {
            const depth = file.extra.replace(currentWorkingDir, '').split('/').length - 1;
            finalScore += depth <= 1 ? 50 : depth <= 2 ? 30 : depth <= 3 ? 15 : 0;
          }

          return {
            ...file,
            matchScore: finalScore,
            matches: bestMatch.matches,
            matchedText,
          };
        })
        .filter((file) => file.matchScore > 0)
        .sort((a, b) => {
          if (!isSlashCommand && mentionGroup(a) !== mentionGroup(b))
            return mentionGroup(a) - mentionGroup(b);
          if (isSlashCommand && commandGroup(a) !== commandGroup(b))
            return commandGroup(a) - commandGroup(b);
          // Sort by score first, then prefer items over directories, then alphabetically
          const scoreDiff = b.matchScore - a.matchScore;
          if (Math.abs(scoreDiff) >= 1) return scoreDiff;
          const typeComparison = compareByType(a, b);
          return typeComparison || a.name.localeCompare(b.name);
        });
    }, [availableItems, query, currentWorkingDir, isSlashCommand, intl]);

    useEffect(() => {
      if (selectedIndex >= displayItems.length && selectedIndex !== 0) onSelectedIndexChange(0);
    }, [displayItems.length, selectedIndex, onSelectedIndexChange]);

    const getSelectionText = (item: DisplayItem): string => {
      if (item.insertText) {
        return item.insertText;
      }
      if (item.itemType === 'Agent') {
        return '@' + item.name + ' ';
      }
      if (['Builtin', 'Recipe', 'Skill'].includes(item.itemType)) {
        return '/' + item.name;
      }
      return item.extra;
    };

    // Keep the first populated menu's footprint while remote inventory arrives.
    // Later entries scroll inside it rather than pushing the menu upwards.
    useLayoutEffect(() => {
      if (!isOpen) {
        setInitialHeight(null);
        return;
      }
      if (addOnly || !isSlashCommand || initialHeight !== null || !displayItems.length) return;
      const height = popoverRef.current?.getBoundingClientRect().height;
      if (height) setInitialHeight(height);
    }, [isOpen, isSlashCommand, addOnly, initialHeight, displayItems.length, position]);

    // Expose methods to parent component
    useImperativeHandle(
      ref,
      () => ({
        getDisplayFiles: () => displayItems,
        selectFile: (index: number) => {
          if (displayItems[index]) {
            const item = displayItems[index];
            if (item.toolboxItem) onSelect(getSelectionText(item), item);
            else onSelect(getSelectionText(item));
            onClose();
          }
        },
      }),
      [displayItems, onSelect, onClose]
    );

    const hasQuery = Boolean(query.trim());
    useEffect(() => {
      if (!isSlashCommand) return;
      let cancelled = false;

      const loadData = async () => {
        const key = JSON.stringify([currentWorkingDir, sessionId, intl.locale]);
        const cached = inventoryCache.current?.key === key ? inventoryCache.current : null;
        setItems([...composerCommandItems(intl), ...(cached?.commands ?? []), ...(cached?.inventory ?? [])]);
        setInventoryError(false);
        if (addOnly && !inventoryRequested && !hasQuery) {
          setIsLoading(false);
          return;
        }
        if (!isSlashCommand && !currentWorkingDir.trim()) {
          setIsLoading(false);
          return;
        }
        setIsLoading(true);
        try {
          if (isSlashCommand) {
            let commandItems: DisplayItem[] = cached?.commands ?? [],
              inventoryItems: DisplayItem[] = cached?.inventory ?? [];
            let failedSource = false;
            const publish = () => {
              if (cancelled) return;
              const builtinItems = composerCommandItems(intl);
              setItems([
                ...builtinItems,
                ...commandItems.filter(
                  (item) =>
                    !builtinItems.some((builtin) => builtin.relativePath === item.relativePath) &&
                    !inventoryItems.some(
                      (entry) =>
                        entry.itemType === 'Skill' &&
                        item.itemType === 'Skill' &&
                        entry.relativePath === item.relativePath
                    )
                ),
                ...inventoryItems,
              ]);
            };
            const failed = () => {
              failedSource = true;
              if (!cancelled) setInventoryError(true);
            };
            const acceptInventory = (result: ToolboxLoadResult) => {
                  if (Object.keys(result.errors).length) failed();
                  inventoryItems = [
                    ...result.model.methods,
                    ...result.model.external,
                    ...result.model.capabilities,
                  ].map((source) => {
                    const item = localizeToolboxItem(source, intl);
                    return {
                      name: item.name,
                      relativePath:
                        source.reference?.value && source.kind !== 'skill'
                          ? source.reference.value
                          : source.name,
                      extra: `${item.status === 'disabled' ? intl.formatMessage(i18n.disabled) + ' · ' : ''}${item.description}`,
                      itemType:
                        item.kind === 'skill' ? 'Skill' : item.kind === 'external' ? 'Mcp' : 'Tool',
                      toolboxItem: source,
                    };
                  });
                  publish();
            };
            await Promise.allSettled([
              listSlashCommandItems(currentWorkingDir, sessionId ?? undefined)
                .then((result) => { commandItems = result; publish(); })
                .catch(failed),
              loadToolbox(currentWorkingDir, sessionId ?? undefined, {
                includeUsage: false,
                onPartial: cached ? undefined : acceptInventory,
              }).then(acceptInventory)
                .catch(failed),
            ]);
            if (!cancelled && !failedSource) inventoryCache.current = {
              key,
              commands: commandItems.filter(item =>
                !composerCommandItems(intl).some(builtin => builtin.relativePath === item.relativePath) &&
                !inventoryItems.some(entry => entry.itemType === 'Skill' && item.itemType === 'Skill' && entry.relativePath === item.relativePath)),
              inventory: inventoryItems,
            };
          }
        } catch (error) {
          if (!cancelled) {
            console.error('Error loading popover items:', error);
            setItems(isSlashCommand ? composerCommandItems(intl) : []);
          }
        } finally {
          if (!cancelled) {
            setIsLoading(false);
          }
        }
      };

      if (isOpen) {
        loadData();
      } else {
        setItems([]);
      }

      return () => {
        cancelled = true;
      };
    }, [isOpen, isSlashCommand, currentWorkingDir, sessionId, intl, addOnly, inventoryRequested, hasQuery]);

    useEffect(() => {
      const handleClickOutside = (event: MouseEvent) => {
        if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
          onClose();
        }
      };

      if (isOpen) {
        document.addEventListener('mousedown', handleClickOutside);
      }

      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }, [isOpen, onClose]);

    // Render keyboard-selected results too, even beyond the current scroll batch.
    const renderedLimit = addOnly ? Math.max(visibleLimit, selectedIndex + 1) : displayItems.length;
    const requestMore = () => {
      if (!addOnly) return;
      setInventoryRequested(true);
      if (inventoryRequested) setVisibleLimit((limit) => Math.max(limit, Math.min(displayItems.length, limit + 20)));
    };
    const hasMore = addOnly && (!inventoryRequested || isLoading || renderedLimit < displayItems.length);
    useEffect(() => {
      if (isOpen && addOnly && selectedIndex > 0 && selectedIndex >= displayItems.length - 1)
        setInventoryRequested(true);
    }, [isOpen, addOnly, selectedIndex, displayItems.length]);

    // Scroll selected item into view
    useEffect(() => {
      // Appending remote results must not pull the user's scroll position back
      // to the previously selected local command.
      if (addOnly && lastScrolledIndex.current === selectedIndex) return;
      if (listRef.current && selectedIndex >= 0 && selectedIndex < displayItems.length) {
        const selectedElement =
          listRef.current.querySelectorAll<HTMLElement>('[role="option"]')[selectedIndex];
        if (selectedElement) {
          lastScrolledIndex.current = selectedIndex;
          selectedElement.scrollIntoView({
            block: 'nearest',
            behavior: 'smooth',
          });
        }
      }
    }, [selectedIndex, displayItems.length, addOnly, isOpen]);

    const handleItemClick = (index: number) => {
      if (index >= 0 && index < displayItems.length) {
        onSelectedIndexChange(index);
        const item = displayItems[index];
        if (item.toolboxItem) onSelect(getSelectionText(item), item);
        else onSelect(getSelectionText(item));
        onClose();
      }
    };

    if (!isOpen || !position) return null;

    const compactMenu = addOnly || isSlashCommand;
    const menuWidth = Math.min(
      compactMenu ? Math.max(280, Math.min(448, position.width * 0.7)) : position.width,
      window.innerWidth - 32
    );

    return createPortal(
      <div
        ref={popoverRef}
        data-composer-menu={addOnly ? 'add' : isSlashCommand ? 'commands' : 'mentions'}
        className={`composer-menu-surface fixed z-50 border border-border-primary shadow-lg ${compactMenu ? 'overflow-hidden rounded-xl' : 'rounded-2xl'}`}
        style={{
          width: menuWidth,
          height: addOnly ? 176 : compactMenu && initialHeight !== null ? initialHeight : undefined,
          maxHeight: Math.max(80, Math.min(compactMenu ? 392 : 560, position.y - 24)),
          left: Math.max(16, Math.min(position.x, window.innerWidth - menuWidth - 16)),
          top: position.y - 10, // Position above the chat input
          transform: 'translateY(-100%)', // Move it fully above
        }}
      >
        <div
          className={`${compactMenu ? 'p-2' : 'p-3'} flex flex-col min-h-0`}
          style={{
            maxHeight: 'inherit',
            height: addOnly || (compactMenu && initialHeight !== null) ? '100%' : undefined,
          }}
        >
          {!isSlashCommand && !currentWorkingDir.trim() && (
            <p className="px-2 pb-2 text-xs text-text-secondary">
              {intl.formatMessage(i18n.chooseProject)}
            </p>
          )}
          {!isSlashCommand && mentionError && (
            <p role="status" className="px-2 pb-2 text-xs text-text-secondary">
              {intl.formatMessage(i18n.failed)}
            </p>
          )}
          {isLoading && displayItems.length === 0 ? (
            <div className="flex items-center justify-center py-4">
              <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2"></div>
              <span className="ml-2 text-sm text-text-secondary">
                {intl.formatMessage(isSlashCommand ? i18n.loadingCommands : i18n.loading)}
              </span>
            </div>
          ) : (
            <>
              {inventoryError && isSlashCommand && (
                <p role="status" className="px-2 pb-2 text-xs text-text-secondary">
                  {intl.formatMessage(i18n.inventoryFailed)}
                </p>
              )}
              {!isSlashCommand && displayItems.length > 0 && (
                <div className="text-xs text-text-secondary mb-2 px-1">
                  {intl.formatMessage(i18n.itemsFound, { count: displayItems.length })}
                </div>
              )}
              <div
                role="listbox"
                ref={listRef}
                onScroll={(event) => {
                  const list = event.currentTarget;
                  if (list.scrollTop > 0 && list.scrollHeight - list.clientHeight - list.scrollTop < 48) requestMore();
                }}
                onWheel={(event) => {
                  const list = event.currentTarget;
                  if (event.deltaY > 0 && list.scrollHeight - list.clientHeight - list.scrollTop < 48) requestMore();
                }}
                className={`${compactMenu ? 'space-y-0.5 overflow-x-hidden' : 'space-y-1'} min-h-0 overflow-y-auto flex-1 scrollbar-thin scrollbar-thumb-borderStandard scrollbar-track-transparent`}
                style={{ maxHeight: isSlashCommand ? '520px' : '280px', scrollbarGutter: 'stable', ...(addOnly ? { overflowY: 'scroll' } : {}) }}
              >
                {displayItems.slice(0, renderedLimit).map((item, index) => (
                  <div
                    key={`${item.itemType}-${item.relativePath}-${item.extra}-${item.insertText ?? ''}`}
                  >
                    {!isSlashCommand &&
                      (index === 0 ||
                        mentionGroup(item) !== mentionGroup(displayItems[index - 1])) && (
                        <div
                          aria-hidden="true"
                          className="px-2 pb-1 pt-2 text-xs text-text-secondary"
                        >
                          {intl.formatMessage(mentionGroupLabels[mentionGroup(item)])}
                        </div>
                      )}
                    {isSlashCommand &&
                      (index === 0 ||
                        commandGroup(item) !== commandGroup(displayItems[index - 1])) && (
                        <div
                          aria-hidden="true"
                          className="px-2 pb-0.5 pt-1 text-[11px] leading-4 text-text-secondary"
                        >
                          {intl.formatMessage(groupLabels[commandGroup(item)])}
                        </div>
                      )}
                    <div
                      role="option"
                      aria-label={
                        isSlashCommand
                          ? `${item.name} ${item.toolboxItem ? '' : '/'}${item.relativePath} ${item.extra}`
                          : undefined
                      }
                      aria-selected={index === selectedIndex}
                      title={
                        isSlashCommand
                          ? `${item.name}${item.extra ? ` — ${item.extra}` : ''}${item.toolboxItem ? `\n${intl.formatMessage(i18n.inventoryHint)}` : ''}`
                          : `${item.name}\n${item.extra}${item.updatedAt ? '\n' + item.updatedAt : ''}`
                      }
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => handleItemClick(index)}
                      data-selected={index === selectedIndex}
                      className={`flex items-center ${compactMenu ? 'gap-2 px-2 py-1.5' : 'gap-3 p-2'} rounded-md cursor-pointer transition-colors ${
                        index === selectedIndex ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/50'
                      }`}
                    >
                      <div
                        className={`flex-shrink-0 text-text-secondary ${compactMenu ? '[&>svg]:size-3.5' : ''}`}
                      >
                        <ItemIcon item={item} />
                      </div>
                      <div
                        className={`flex-1 min-w-0 flex items-baseline gap-x-3 ${compactMenu ? '' : 'flex-wrap gap-y-0.5'}`}
                      >
                        <div
                          className={`flex items-baseline text-text-primary ${compactMenu ? 'min-w-0 flex-1 gap-x-1.5 text-xs leading-4' : 'flex-wrap gap-x-2 text-sm'}`}
                        >
                          <span className={compactMenu ? 'min-w-0 truncate' : undefined}>
                            {item.name}
                          </span>
                          {isSlashCommand &&
                            (!item.toolboxItem || item.relativePath !== item.name) && (
                              <span className="max-w-[45%] shrink-0 truncate text-[11px] leading-4 text-text-secondary">
                                {item.toolboxItem ? '' : '/'}
                                {item.relativePath}
                              </span>
                            )}
                        </div>
                        <div
                          className={`text-right text-text-secondary ${compactMenu ? 'min-w-0 flex-[0_1_44%] truncate text-[11px] leading-4' : 'min-w-[10rem] flex-1 break-words text-xs line-clamp-2'}`}
                        >
                          {item.extra}
                        </div>
                      </div>
                      {item.updatedAt && Number.isFinite(Date.parse(item.updatedAt)) && (
                        <time
                          dateTime={item.updatedAt}
                          className="shrink-0 text-xs text-text-secondary"
                        >
                          {intl.formatDate(item.updatedAt, { month: 'short', day: 'numeric' })}
                        </time>
                      )}
                    </div>
                  </div>
                ))}

                {hasMore && (
                  <div className="px-2 py-2">
                    {isLoading ? <div role="status" className="text-xs text-text-secondary">{intl.formatMessage(i18n.loadingCommands)}</div> :
                      <button type="button" onClick={requestMore} className="w-full rounded py-1 text-left text-xs text-text-secondary hover:text-text-primary focus-visible:outline">
                        {intl.formatMessage(i18n.loadMore)}
                      </button>}
                  </div>
                )}

                {!isLoading && displayItems.length === 0 && (
                  <div className="p-4 text-center text-text-secondary text-sm">
                    {intl.formatMessage(
                      isSlashCommand
                        ? i18n.noCommandsFound
                        : query
                          ? i18n.noItemsFound
                          : i18n.empty,
                      {
                        query,
                      }
                    )}
                  </div>
                )}
              </div>
              {!isSlashCommand && (
                <div className="mt-2 border-t border-border-primary pt-2 px-1 text-xs text-text-secondary">
                  {isLoading
                    ? intl.formatMessage(i18n.loading)
                    : truncated
                      ? intl.formatMessage(i18n.more)
                      : intl.formatMessage(i18n.keys)}
                </div>
              )}
            </>
          )}
        </div>
      </div>,
      document.body
    );
  }
);

MentionPopover.displayName = 'MentionPopover';

export default MentionPopover;
