import { composerCommandItems } from './composerCommands';
import {
  forwardRef,
  useCallback,
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
import { loadToolbox } from '../acp/toolbox';
import { localizeToolboxItem } from './toolbox/toolboxLocalization';
import type { ToolboxItem } from '../types/toolbox';

const i18n = defineMessages({
  addGroup: { id: 'mentionPopover.addGroup', defaultMessage: 'Add' },
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
type DisplayItemType = CommandItemType | 'Directory' | 'File' | 'Mcp' | 'Tool';

const typeOrder: Record<DisplayItemType, number> = {
  Agent: 0,
  Directory: 1,
  File: 2,
  Builtin: 3,
  Skill: 4,
  Recipe: 5,
  Mcp: 6,
  Tool: 7,
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
}

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
    const popoverRef = useRef<HTMLDivElement>(null);
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

    const scanDirectoryFromRoot = useCallback(
      async (dirPath: string, relativePath = '', depth = 0): Promise<DisplayItem[]> => {
        // Increase depth limit for better file discovery
        if (depth > 5) return [];

        try {
          const items = await window.electron.listFiles(dirPath);
          const results: DisplayItem[] = [];

          // Common directories to prioritize or skip
          const priorityDirs = [
            'Desktop',
            'Documents',
            'Downloads',
            'Projects',
            'Development',
            'Code',
            'src',
            'components',
            'icons',
          ];
          const skipDirs = [
            '.git',
            '.svn',
            '.hg',
            'node_modules',
            '__pycache__',
            'target',
            'dist',
            'build',
            '.cache',
            '.npm',
            '.yarn',
            'Library',
            'System',
            'Applications',
            '.Trash',
          ];

          const allowedHiddenDirs = [
            '.github',
            '.vscode',
            '.idea',
            '.config',
            '.gitlab',
            '.circleci',
            '.azure',
            '.jenkins',
          ];

          // Don't skip as many directories at deeper levels to find more items
          const skipDirsAtDepth =
            depth > 2 ? ['.git', '.svn', '.hg', 'node_modules', '__pycache__'] : skipDirs;

          // Sort items to prioritize certain directories
          const sortedItems = items.sort((a, b) => {
            const aPriority = priorityDirs.includes(a);
            const bPriority = priorityDirs.includes(b);
            if (aPriority && !bPriority) return -1;
            if (!aPriority && bPriority) return 1;
            return a.localeCompare(b);
          });

          // Increase item limit per directory for better coverage
          const itemLimit = depth === 0 ? 50 : depth === 1 ? 40 : 30;

          for (const item of sortedItems.slice(0, itemLimit)) {
            const fullPath = `${dirPath}/${item}`;
            const itemRelativePath = relativePath ? `${relativePath}/${item}` : item;

            // Skip items in the skip list
            if (skipDirsAtDepth.includes(item)) {
              continue;
            }

            // Skip hidden items except for allowed hidden directories
            if (item.startsWith('.') && !allowedHiddenDirs.includes(item)) {
              continue;
            }

            // First, check if this looks like a file based on extension
            const hasExtension = item.includes('.');
            const ext = item.split('.').pop()?.toLowerCase();
            const commonExtensions = [
              // Code items
              'txt',
              'md',
              'js',
              'ts',
              'jsx',
              'tsx',
              'py',
              'java',
              'cpp',
              'c',
              'h',
              'css',
              'html',
              'json',
              'xml',
              'yaml',
              'yml',
              'toml',
              'ini',
              'cfg',
              'sh',
              'bat',
              'ps1',
              'rb',
              'go',
              'rs',
              'php',
              'sql',
              'r',
              'scala',
              'swift',
              'kt',
              'dart',
              'vue',
              'svelte',
              'astro',
              'scss',
              'less',
              // Documentation
              'readme',
              'license',
              'changelog',
              'contributing',
              // Config items
              'gitignore',
              'dockerignore',
              'editorconfig',
              'prettierrc',
              'eslintrc',
              // Images and assets
              'png',
              'jpg',
              'jpeg',
              'gif',
              'svg',
              'ico',
              'webp',
              'bmp',
              'tiff',
              'tif',
              // Vector and design items
              'ai',
              'eps',
              'sketch',
              'fig',
              'xd',
              'psd',
              // Other common items
              'pdf',
              'doc',
              'docx',
              'xls',
              'xlsx',
              'ppt',
              'pptx',
            ];

            // If it has a known file extension, treat it as a file
            if (hasExtension && ext && commonExtensions.includes(ext)) {
              results.push({
                extra: fullPath,
                name: item,
                itemType: 'File',
                relativePath: itemRelativePath,
              });
              continue;
            }

            // If it's a known file without extension (README, LICENSE, etc.)
            const knownFiles = [
              'readme',
              'license',
              'changelog',
              'contributing',
              'dockerfile',
              'makefile',
            ];
            if (!hasExtension && knownFiles.includes(item.toLowerCase())) {
              results.push({
                extra: fullPath,
                name: item,
                itemType: 'File',
                relativePath: itemRelativePath,
              });
              continue;
            }

            // Otherwise, try to determine if it's a directory
            try {
              await window.electron.listFiles(fullPath);

              results.push({
                name: item,
                extra: fullPath,
                itemType: 'Directory',
                relativePath: itemRelativePath,
              });

              // Recursively scan directories more aggressively
              if (depth < 4 || priorityDirs.includes(item)) {
                const subFiles = await scanDirectoryFromRoot(fullPath, itemRelativePath, depth + 1);
                results.push(...subFiles);
              }
            } catch {
              // If we can't list it and it doesn't have a known extension, skip it
              // This could be a file with an unknown extension or a permission issue
            }
          }

          return results;
        } catch (error) {
          console.error(`Error scanning directory ${dirPath}:`, error);
          return [];
        }
      },
      []
    );

    const getDefaultStartPath = (): string => {
      if (window.electron.platform === 'win32') return 'C:\\Users';
      if (window.electron.platform === 'linux') return '/home';
      return '/Users';
    };

    const compareByType = (a: DisplayItemWithMatch, b: DisplayItemWithMatch) => {
      const orderA = typeOrder[a.itemType] ?? Number.MAX_SAFE_INTEGER;
      const orderB = typeOrder[b.itemType] ?? Number.MAX_SAFE_INTEGER;
      return orderA - orderB;
    };

    const displayItems = useMemo((): DisplayItemWithMatch[] => {
      if (!query.trim()) {
        return items
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
            if (isSlashCommand && commandGroup(a) !== commandGroup(b))
              return commandGroup(a) - commandGroup(b);
            if (isSlashCommand && a.commandOrder !== undefined && b.commandOrder !== undefined)
              return a.commandOrder - b.commandOrder;
            if (a.depth !== b.depth) return a.depth - b.depth;
            const typeComparison = compareByType(a, b);
            return typeComparison || a.name.localeCompare(b.name);
          });
      }

      return items
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
          if (isSlashCommand && commandGroup(a) !== commandGroup(b))
            return commandGroup(a) - commandGroup(b);
          // Sort by score first, then prefer items over directories, then alphabetically
          const scoreDiff = b.matchScore - a.matchScore;
          if (Math.abs(scoreDiff) >= 1) return scoreDiff;
          const typeComparison = compareByType(a, b);
          return typeComparison || a.name.localeCompare(b.name);
        });
    }, [items, query, currentWorkingDir, isSlashCommand, intl]);

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

    useEffect(() => {
      let cancelled = false;

      const loadData = async () => {
        setItems(isSlashCommand ? composerCommandItems(intl) : []);
        setInventoryError(false);
        if (!isSlashCommand && !currentWorkingDir.trim()) {
          setIsLoading(false);
          return;
        }
        setIsLoading(!isSlashCommand);
        try {
          if (isSlashCommand) {
            let commandItems: DisplayItem[] = [],
              inventoryItems: DisplayItem[] = [];
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
              if (!cancelled) setInventoryError(true);
            };
            await Promise.allSettled([
              listSlashCommandItems(currentWorkingDir, sessionId ?? undefined)
                .then((result) => {
                  commandItems = result;
                  publish();
                })
                .catch(failed),
              loadToolbox(currentWorkingDir, sessionId ?? undefined)
                .then((result) => {
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
                })
                .catch(failed),
            ]);
          } else {
            // Fetch agents from server and scan files in parallel
            const [agentItems, scannedFiles] = await Promise.all([
              listAgentMentionItems(currentWorkingDir, sessionId ?? undefined).catch(() => []),
              scanDirectoryFromRoot(currentWorkingDir || getDefaultStartPath()),
            ]);
            if (cancelled) return;
            setItems([...agentItems, ...scannedFiles]);
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
      }

      return () => {
        cancelled = true;
      };
    }, [isOpen, isSlashCommand, scanDirectoryFromRoot, currentWorkingDir, sessionId, intl]);

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

    // Scroll selected item into view
    useEffect(() => {
      if (listRef.current && selectedIndex >= 0 && selectedIndex < displayItems.length) {
        const selectedElement =
          listRef.current.querySelectorAll<HTMLElement>('[role="option"]')[selectedIndex];
        if (selectedElement) {
          selectedElement.scrollIntoView({
            block: 'nearest',
            behavior: 'smooth',
          });
        }
      }
    }, [selectedIndex, displayItems.length]);

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

    return (
      <div
        ref={popoverRef}
        className="fixed z-50 bg-background-primary border border-border-primary rounded-2xl shadow-lg"
        style={{
          width: Math.min(position.width ?? 640, window.innerWidth - 32),
          maxHeight: Math.max(80, Math.min(560, position.y - 24)),
          left: Math.max(
            16,
            Math.min(
              position.x,
              window.innerWidth - Math.min(position.width ?? 640, window.innerWidth - 32) - 16
            )
          ),
          top: position.y - 10, // Position above the chat input
          transform: 'translateY(-100%)', // Move it fully above
        }}
      >
        <div className="p-3 flex flex-col min-h-0" style={{ maxHeight: 'inherit' }}>
          {isLoading ? (
            <div className="flex items-center justify-center py-4">
              <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2"></div>
              <span className="ml-2 text-sm text-text-secondary">
                {intl.formatMessage(isSlashCommand ? i18n.loadingCommands : i18n.scanningFiles)}
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
                className="space-y-1 min-h-0 overflow-y-auto flex-1 scrollbar-thin scrollbar-thumb-borderStandard scrollbar-track-transparent"
                style={{ maxHeight: isSlashCommand ? '520px' : '280px' }}
              >
                {displayItems.map((item, index) => (
                  <div
                    key={`${item.itemType}-${item.relativePath}-${item.extra}-${item.insertText ?? ''}`}
                  >
                    {isSlashCommand &&
                      (index === 0 ||
                        commandGroup(item) !== commandGroup(displayItems[index - 1])) && (
                        <div
                          aria-hidden="true"
                          className="px-2 pb-1 pt-2 text-xs text-text-secondary"
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
                      title={item.toolboxItem ? intl.formatMessage(i18n.inventoryHint) : undefined}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => handleItemClick(index)}
                      data-selected={index === selectedIndex}
                      className={`flex items-center gap-3 p-2 rounded-md cursor-pointer transition-colors ${
                        index === selectedIndex ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/50'
                      }`}
                    >
                      <div className="flex-shrink-0 text-text-secondary">
                        <ItemIcon item={item} />
                      </div>
                      <div className="flex-1 min-w-0 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                        <div className="flex flex-wrap items-baseline gap-x-2 text-sm text-text-primary">
                          <span>{item.name}</span>
                          {isSlashCommand &&
                            (!item.toolboxItem || item.relativePath !== item.name) && (
                              <span className="text-xs text-text-secondary">
                                {item.toolboxItem ? '' : '/'}
                                {item.relativePath}
                              </span>
                            )}
                        </div>
                        <div className="min-w-[10rem] flex-1 break-words text-right text-xs text-text-secondary line-clamp-2">
                          {item.extra}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}

                {!isLoading && displayItems.length === 0 && query && (
                  <div className="p-4 text-center text-text-secondary text-sm">
                    {intl.formatMessage(isSlashCommand ? i18n.noCommandsFound : i18n.noItemsFound, {
                      query,
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    );
  }
);

MentionPopover.displayName = 'MentionPopover';

export default MentionPopover;
