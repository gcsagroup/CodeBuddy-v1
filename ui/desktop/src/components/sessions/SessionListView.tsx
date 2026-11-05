import { AppEvents } from '../../constants/events';
import { canForkSession, sessionCapabilityMessages } from '../../utils/sessionCapabilities';
import React, { useEffect, useState, useRef, useCallback, useMemo, startTransition } from 'react';
import { defineMessages, useIntl } from '../../i18n';
import {
  MessageSquareText,
  AlertCircle,
  Folder,
  Edit2,
  Trash2,
  Download,
  Upload,
  Share2,
  LoaderCircle,
  ExternalLink,
  Copy,
  Archive,
  ArchiveRestore,
  MoreHorizontal,
  Search,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '../ui/dropdown-menu';
import { Button } from '../ui/button';
import { ScrollArea } from '../ui/scroll-area';
import { formatMessageTimestamp } from '../../utils/timeUtils';
import { MainPanelLayout } from '../Layout/MainPanelLayout';
import { groupSessionsByDate, sessionActivityAt, type DateGroup } from '../../utils/dateUtils';
import { errorMessage } from '../../utils/conversionUtils';
import { Skeleton } from '../ui/skeleton';
import { toast } from 'react-toastify';
import { ConfirmationModal } from '../ui/ConfirmationModal';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import {
  acpDeleteSession,
  acpArchiveSession,
  acpExportSession,
  acpForkSession,
  acpImportSession,
  acpListSessions,
  acpRenameSession,
  acpUnarchiveSession,
  acpShareSessionNostr,
  type SessionListItem,
  type SessionWorkspaceMode,
} from '../../acp/sessions';
import { acpChatSessionActions } from '../../acp/chatSessionStore';
import { cancelAcpPermissionRequestsForSession } from '../../acp/permissionRequests';
import { cancelAcpElicitationRequestsForSession } from '../../acp/elicitationRequests';
import { toPrimaryDeepLink } from '../../utils/deepLinkProtocol';

const i18n = defineMessages({
  editSessionTitle: { id: 'sessions.edit.title', defaultMessage: 'Edit Session Description' },
  editSessionPlaceholder: {
    id: 'sessions.edit.placeholder',
    defaultMessage: 'Enter session description',
  },
  cancel: { id: 'sessions.cancel', defaultMessage: 'Cancel' },
  save: { id: 'sessions.save', defaultMessage: 'Save' },
  saving: { id: 'sessions.saving', defaultMessage: 'Saving...' },
  sessionUpdated: {
    id: 'sessions.toast.updated',
    defaultMessage: 'Session description updated successfully',
  },
  sessionUpdateFailed: {
    id: 'sessions.toast.updateFailed',
    defaultMessage: 'Failed to update session description: {error}',
  },
  chatHistory: { id: 'sessions.chatHistory', defaultMessage: 'History' },
  importSession: { id: 'sessions.import', defaultMessage: 'Import Session' },
  importNostrSession: { id: 'sessions.importNostr', defaultMessage: 'Import Link' },
  importNostrTitle: { id: 'sessions.importNostr.title', defaultMessage: 'Import Nostr Session' },
  importNostrDesc: {
    id: 'sessions.importNostr.description',
    defaultMessage: 'Paste a CodeBuddy Nostr share link to fetch, decrypt, and import the session.',
  },
  importNostrPlaceholder: {
    id: 'sessions.importNostr.placeholder',
    defaultMessage: 'codebuddy://sessions/nostr?nevent=...&key=...',
  },
  importing: { id: 'sessions.importing', defaultMessage: 'Importing...' },
  chatHistoryDesc: {
    id: 'sessions.chatHistoryDesc',
    defaultMessage: 'View and search your past conversations with CodeBuddy. {shortcut} to search.',
  },
  searchPlaceholder: { id: 'sessions.searchPlaceholder', defaultMessage: 'Search history...' },
  errorLoading: { id: 'sessions.error.loading', defaultMessage: 'Error Loading Sessions' },
  tryAgain: { id: 'sessions.error.tryAgain', defaultMessage: 'Try Again' },
  noSessions: { id: 'sessions.empty.title', defaultMessage: 'No chat sessions found' },
  noSessionsDesc: {
    id: 'sessions.empty.description',
    defaultMessage: 'Your chat history will appear here',
  },
  noMatching: { id: 'sessions.search.noResults', defaultMessage: 'No matching sessions found' },
  noMatchingDesc: {
    id: 'sessions.search.noResultsDesc',
    defaultMessage: 'Try adjusting your search terms',
  },
  loadingMore: { id: 'sessions.loadingMore', defaultMessage: 'Loading more sessions...' },
  deleteTitle: {
    id: 'sessions.history.deleteTitle',
    defaultMessage: 'Permanently delete conversation',
  },
  deleteMessage: {
    id: 'sessions.history.deleteMessage',
    defaultMessage:
      'Permanently remove "{name}" from your conversation history? You cannot restore it in CodeBuddy. Files in the workspace will be kept.',
  },
  duplicateSuccess: {
    id: 'sessions.toast.duplicated',
    defaultMessage: 'Branch created from "{name}"',
  },
  duplicateFailed: {
    id: 'sessions.toast.duplicateFailed',
    defaultMessage: 'Failed to branch conversation: {error}',
  },
  deleteSuccess: { id: 'sessions.toast.deleted', defaultMessage: 'Session deleted successfully' },
  deleteFailed: {
    id: 'sessions.toast.deleteFailed',
    defaultMessage: 'Failed to delete session "{name}": {error}',
  },
  importSuccess: { id: 'sessions.toast.imported', defaultMessage: 'Session imported successfully' },
  importFailed: {
    id: 'sessions.toast.importFailed',
    defaultMessage: 'Failed to import session: {error}',
  },
  exportSuccess: { id: 'sessions.toast.exported', defaultMessage: 'Session exported successfully' },
  shareNostrSuccess: {
    id: 'sessions.toast.shareNostr',
    defaultMessage: 'Encrypted Nostr share link created',
  },
  shareNostrFailed: {
    id: 'sessions.toast.shareNostrFailed',
    defaultMessage: 'Failed to create Nostr share link: {error}',
  },
  copied: { id: 'sessions.toast.copied', defaultMessage: 'Copied to clipboard' },
  openInNewWindow: { id: 'sessions.action.openNewWindow', defaultMessage: 'Open in new window' },
  editSessionName: { id: 'sessions.action.editName', defaultMessage: 'Edit session name' },
  duplicateSession: { id: 'sessions.action.duplicate', defaultMessage: 'Branch conversation' },
  deleteSession: { id: 'sessions.action.delete', defaultMessage: 'Delete session' },
  exportSession: { id: 'sessions.action.export', defaultMessage: 'Export session' },
  restoreForActions: {
    id: 'sessions.archived.restoreForActions',
    defaultMessage:
      'Restore this session before opening, editing, duplicating, exporting or sharing it.',
  },
  exportFailed: {
    id: 'sessions.toast.exportFailed',
    defaultMessage: 'Failed to export session: {error}',
  },
  shareNostrSession: {
    id: 'sessions.action.shareNostr',
    defaultMessage: 'Share encrypted Nostr link',
  },
  shareNostrTitle: {
    id: 'sessions.shareNostr.title',
    defaultMessage: 'Encrypted Nostr Share Link',
  },
  shareNostrDesc: {
    id: 'sessions.shareNostr.description',
    defaultMessage:
      'Anyone with this link can fetch and decrypt the session. Treat it like a secret.',
  },
  close: { id: 'sessions.close', defaultMessage: 'Close' },
  historyView: { id: 'sessions.filter.historyView', defaultMessage: 'History view' },
  activeSessions: { id: 'sessions.filter.active', defaultMessage: 'Active' },
  archivedSessions: { id: 'sessions.filter.archived', defaultMessage: 'Archived' },
  allSessions: { id: 'sessions.filter.all', defaultMessage: 'All' },
  projectFilter: { id: 'sessions.filter.project', defaultMessage: 'Project filter' },
  allProjects: { id: 'sessions.filter.allProjects', defaultMessage: 'All projects' },
  dateFilter: { id: 'sessions.filter.date', defaultMessage: 'Date filter' },
  allDates: { id: 'sessions.filter.allDates', defaultMessage: 'All time' },
  today: { id: 'sessions.filter.today', defaultMessage: 'Today' },
  lastSevenDays: { id: 'sessions.filter.lastSevenDays', defaultMessage: 'Last 7 days' },
  lastThirtyDays: { id: 'sessions.filter.lastThirtyDays', defaultMessage: 'Last 30 days' },
  archiveSession: { id: 'sessions.action.archive', defaultMessage: 'Archive session' },
  unarchiveSession: { id: 'sessions.action.unarchive', defaultMessage: 'Unarchive session' },
  archiveSuccess: { id: 'sessions.toast.archived', defaultMessage: 'Session archived' },
  unarchiveSuccess: { id: 'sessions.toast.unarchived', defaultMessage: 'Session restored' },
  archiveFailed: {
    id: 'sessions.toast.archiveFailed',
    defaultMessage: 'Failed to update session archive: {error}',
  },
  archiveNotice: {
    id: 'sessions.history.archiveNotice',
    defaultMessage:
      'Archiving keeps your conversation and removes it from the sidebar. Restore it here whenever you need it.',
  },
  description: {
    id: 'sessions.history.description',
    defaultMessage: 'Find past conversations and manage your archive.',
  },
  conversations: { id: 'sessions.history.conversations', defaultMessage: 'Conversations' },
  restore: { id: 'sessions.history.restore', defaultMessage: 'Restore' },
  permanentDelete: { id: 'sessions.history.permanentDelete', defaultMessage: 'Permanently delete' },
  more: { id: 'sessions.history.more', defaultMessage: 'More actions for {name}' },
  noProject: { id: 'sessions.history.noProject', defaultMessage: 'No project' },
  count: { id: 'sessions.history.count', defaultMessage: '{count} conversations' },
  archiveEmpty: {
    id: 'sessions.history.archiveEmpty',
    defaultMessage: 'No archived conversations',
  },
  archiveEmptyDescription: {
    id: 'sessions.history.archiveEmptyDescription',
    defaultMessage:
      'Conversations you archive from the sidebar will appear here. Their messages are kept.',
  },
});

type HistoryView = 'active' | 'archived' | 'all';
type HistoryDateFilter = 'all' | 'today' | '7d' | '30d';

function matchesDateFilter(session: SessionListItem, filter: HistoryDateFilter, now: number) {
  if (filter === 'all') return true;
  const activityAt = Date.parse(sessionActivityAt(session));
  if (!Number.isFinite(activityAt)) return false;
  if (filter === 'today') {
    const current = new Date(now);
    const activity = new Date(activityAt);
    return (
      current.getFullYear() === activity.getFullYear() &&
      current.getMonth() === activity.getMonth() &&
      current.getDate() === activity.getDate()
    );
  }
  const days = filter === '7d' ? 7 : 30;
  return activityAt >= now - days * 24 * 60 * 60 * 1000;
}

interface EditSessionModalProps {
  session: SessionListItem | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (sessionId: string, newDescription: string) => Promise<void>;
  disabled?: boolean;
}

const EditSessionModal = React.memo<EditSessionModalProps>(
  ({ session, isOpen, onClose, onSave, disabled = false }) => {
    const intl = useIntl();
    const [description, setDescription] = useState('');
    const [isUpdating, setIsUpdating] = useState(false);

    useEffect(() => {
      if (session && isOpen) {
        setDescription(session.name);
      } else if (!isOpen) {
        setDescription('');
        setIsUpdating(false);
      }
    }, [session, isOpen]);

    const handleSave = useCallback(async () => {
      if (!session || disabled) return;

      const trimmedDescription = description.trim();
      if (trimmedDescription === session.name) {
        onClose();
        return;
      }

      setIsUpdating(true);
      try {
        await acpRenameSession(session.id, trimmedDescription);
        await onSave(session.id, trimmedDescription);
        onClose();
        setTimeout(() => {
          toast.success(intl.formatMessage(i18n.sessionUpdated));
        }, 300);
      } catch (error) {
        const errMsg = errorMessage(error, 'Unknown error occurred');
        console.error('Failed to update session description:', errMsg);
        toast.error(intl.formatMessage(i18n.sessionUpdateFailed, { error: errMsg }));
        setDescription(session.name);
      } finally {
        setIsUpdating(false);
      }
    }, [session, description, onSave, onClose, disabled, intl]);

    const handleCancel = useCallback(() => {
      if (!isUpdating) {
        onClose();
      }
    }, [onClose, isUpdating]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter' && !isUpdating) {
          handleSave();
        } else if (e.key === 'Escape' && !isUpdating) {
          handleCancel();
        }
      },
      [handleSave, handleCancel, isUpdating]
    );

    const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      setDescription(e.target.value);
    }, []);

    if (!isOpen || !session) return null;

    return (
      <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50">
        <div className="bg-background-primary border border-border-primary rounded-lg p-6 w-[500px] max-w-[90vw]">
          <h3 className="text-lg font-medium text-text-primary mb-4">
            {intl.formatMessage(i18n.editSessionTitle)}
          </h3>

          <div className="space-y-4">
            <div>
              <input
                id="session-description"
                type="text"
                value={description}
                onChange={handleInputChange}
                className="w-full p-3 border border-border-primary rounded-lg bg-background-primary text-text-primary focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder={intl.formatMessage(i18n.editSessionPlaceholder)}
                autoFocus
                maxLength={200}
                onKeyDown={handleKeyDown}
                disabled={isUpdating || disabled}
              />
            </div>
          </div>

          <div className="flex justify-end space-x-3 mt-6">
            <Button onClick={handleCancel} variant="ghost" disabled={isUpdating || disabled}>
              {intl.formatMessage(i18n.cancel)}
            </Button>
            <Button
              onClick={handleSave}
              disabled={!description.trim() || isUpdating || disabled}
              variant="default"
            >
              {isUpdating ? intl.formatMessage(i18n.saving) : intl.formatMessage(i18n.save)}
            </Button>
          </div>
        </div>
      </div>
    );
  }
);

EditSessionModal.displayName = 'EditSessionModal';

// Debounce hook for search
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      window.clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}

interface SessionListViewProps {
  onSelectSession: (sessionId: string) => void;
  workspaceMode: SessionWorkspaceMode;
}

const SessionListView: React.FC<SessionListViewProps> = React.memo(
  ({ onSelectSession, workspaceMode }) => {
    const intl = useIntl();
    const [sessions, setSessions] = useState<SessionListItem[]>([]);
    const [isPrefetchingSessions, setIsPrefetchingSessions] = useState(false);
    const [dateGroups, setDateGroups] = useState<DateGroup[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [showSkeleton, setShowSkeleton] = useState(true);
    const [showContent, setShowContent] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [visibleGroupsCount, setVisibleGroupsCount] = useState(15);

    // Edit modal state
    const [showEditModal, setShowEditModal] = useState(false);
    const [editingSession, setEditingSession] = useState<SessionListItem | null>(null);

    // Delete confirmation modal state
    const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);
    const [sessionToDelete, setSessionToDelete] = useState<SessionListItem | null>(null);

    const [showImportLinkModal, setShowImportLinkModal] = useState(false);
    const [nostrImportLink, setNostrImportLink] = useState('');
    const [isImportingNostr, setIsImportingNostr] = useState(false);
    const [shareLink, setShareLink] = useState('');
    const [showShareLinkModal, setShowShareLinkModal] = useState(false);
    const [sharingSessionId, setSharingSessionId] = useState<string | null>(null);
    const [archivingSessionId, setArchivingSessionId] = useState<string | null>(null);
    const mutationRef = useRef(false);
    const [deleting, setDeleting] = useState(false);
    const [nostrEnabled, setNostrEnabled] = useState(true);
    const [historyView, setHistoryView] = useState<HistoryView>('active');
    const [projectFilter, setProjectFilter] = useState('all');
    const [dateFilter, setDateFilter] = useState<HistoryDateFilter>('all');

    // Search state for debouncing
    const [searchTerm, setSearchTerm] = useState('');
    const debouncedSearchTerm = useDebounce(searchTerm, 300); // 300ms debounce
    const debouncedSearchTermRef = useRef(debouncedSearchTerm);
    debouncedSearchTermRef.current = debouncedSearchTerm;

    const containerRef = useRef<HTMLDivElement>(null);
    const loadGenerationRef = useRef(0);
    const hasLoadedRef = useRef(false);

    const fileInputRef = useRef<HTMLInputElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
      const focusSearch = (event: KeyboardEvent) => {
        if (
          (window.electron.platform === 'darwin' ? event.metaKey : event.ctrlKey) &&
          event.key.toLowerCase() === 'f'
        ) {
          event.preventDefault();
          searchInputRef.current?.focus();
        }
      };
      window.addEventListener('keydown', focusSearch);
      return () => window.removeEventListener('keydown', focusSearch);
    }, []);

    const projectOptions = useMemo(
      () => Array.from(new Set(sessions.map((session) => session.workingDir))).sort(),
      [sessions]
    );
    const visibleSessions = useMemo(() => {
      const now = Date.now();
      return sessions.filter((session) => {
        const isArchived = Boolean(session.archivedAt);
        if (historyView === 'active' && isArchived) return false;
        if (historyView === 'archived' && !isArchived) return false;
        if (projectFilter !== 'all' && session.workingDir !== projectFilter) return false;
        return matchesDateFilter(session, dateFilter, now);
      });
    }, [dateFilter, historyView, projectFilter, sessions]);
    const hasManagementFilter =
      historyView !== 'active' || projectFilter !== 'all' || dateFilter !== 'all';

    const visibleDateGroups = useMemo(() => {
      return dateGroups.slice(0, visibleGroupsCount);
    }, [dateGroups, visibleGroupsCount]);

    const archiveGroups = useMemo(() => {
      const groups = new Map<string, SessionListItem[]>();
      for (const session of visibleSessions) {
        const entries = groups.get(session.workingDir) ?? [];
        entries.push(session);
        groups.set(session.workingDir, entries);
      }
      return Array.from(groups, ([path, items]) => ({ path, sessions: items }));
    }, [visibleSessions]);

    const previousSearchTermRef = useRef('');
    useEffect(() => {
      const wasSearching = previousSearchTermRef.current.length > 0;
      const isSearching = debouncedSearchTerm.length > 0;
      previousSearchTermRef.current = debouncedSearchTerm;

      if (isSearching) {
        setVisibleGroupsCount(dateGroups.length);
      } else if (wasSearching) {
        setVisibleGroupsCount(15);
      }
    }, [debouncedSearchTerm, dateGroups.length]);

    const loadRemainingSessionPages = useCallback(
      async (initialCursor: string, loadId: number, keyword?: string) => {
        let cursor: string | null = initialCursor;
        setIsPrefetchingSessions(true);

        try {
          while (cursor && loadGenerationRef.current === loadId) {
            const resp = await acpListSessions(
              cursor,
              { keyword, includeArchived: true },
              workspaceMode
            );
            if (loadGenerationRef.current !== loadId) return;

            cursor = resp.nextCursor;
            startTransition(() => {
              setSessions((prev) => {
                const seen = new Set(prev.map((s) => s.id));
                return [...prev, ...resp.sessions.filter((s) => !seen.has(s.id))];
              });
            });
          }
        } catch (err) {
          console.error('Failed to load remaining sessions:', err);
        } finally {
          if (loadGenerationRef.current === loadId) {
            setIsPrefetchingSessions(false);
          }
        }
      },
      [workspaceMode]
    );

    const loadSessions = useCallback(
      async (keyword: string = debouncedSearchTermRef.current) => {
        const loadId = loadGenerationRef.current + 1;
        loadGenerationRef.current = loadId;
        // Only show the skeleton on the first load; subsequent loads (e.g. typing a
        // search keyword) update the list in place without flashing the skeleton.
        const isFirstLoad = !hasLoadedRef.current;
        setIsPrefetchingSessions(false);
        setError(null);
        if (isFirstLoad) {
          setIsLoading(true);
          setShowSkeleton(true);
          setShowContent(false);
        }
        try {
          const resp = await acpListSessions(
            undefined,
            { keyword, includeArchived: true },
            workspaceMode
          );
          if (loadGenerationRef.current !== loadId) return;
          hasLoadedRef.current = true;

          startTransition(() => {
            setSessions(resp.sessions);
          });

          if (resp.nextCursor) {
            void loadRemainingSessionPages(resp.nextCursor, loadId, keyword);
          }
        } catch (err) {
          if (loadGenerationRef.current !== loadId) return;

          console.error('Failed to load sessions:', err);
          setError('Failed to load sessions. Please try again later.');
          setSessions([]);
        } finally {
          if (loadGenerationRef.current === loadId && isFirstLoad) {
            setIsLoading(false);
          }
        }
      },
      [loadRemainingSessionPages, workspaceMode]
    );

    const handleScroll = useCallback(
      (target: HTMLDivElement) => {
        const { scrollTop, scrollHeight, clientHeight } = target;
        const threshold = 200;

        if (scrollHeight - scrollTop - clientHeight >= threshold) return;

        if (visibleGroupsCount < dateGroups.length) {
          setVisibleGroupsCount((prev) => Math.min(prev + 5, dateGroups.length));
        }
      },
      [visibleGroupsCount, dateGroups.length]
    );

    useEffect(() => {
      loadSessions(debouncedSearchTerm);
      return () => {
        // Bump the generation so any in-flight load for the previous keyword is discarded.
        loadGenerationRef.current += 1;
      };
    }, [loadSessions, debouncedSearchTerm]);

    useEffect(() => {
      const refreshSessions = () => {
        void loadSessions(debouncedSearchTerm);
      };
      window.addEventListener(AppEvents.SESSION_ARCHIVED, refreshSessions);
      window.addEventListener(AppEvents.SESSION_UNARCHIVED, refreshSessions);
      window.addEventListener(AppEvents.SESSION_RENAMED, refreshSessions);
      window.addEventListener(AppEvents.SESSION_DELETED, refreshSessions);
      return () => {
        window.removeEventListener(AppEvents.SESSION_ARCHIVED, refreshSessions);
        window.removeEventListener(AppEvents.SESSION_UNARCHIVED, refreshSessions);
        window.removeEventListener(AppEvents.SESSION_RENAMED, refreshSessions);
        window.removeEventListener(AppEvents.SESSION_DELETED, refreshSessions);
      };
    }, [loadSessions, debouncedSearchTerm]);

    // Hide Nostr sharing when explicitly disabled via env var (restricted/enterprise bundles)
    useEffect(() => {
      const config = window.electron.getConfig();
      if (config.GOOSE_DISABLE_NOSTR_SHARING === true) {
        setNostrEnabled(false);
      }
    }, []);

    // Timing logic to prevent flicker between skeleton and content on initial load
    useEffect(() => {
      if (!isLoading && showSkeleton) {
        setShowSkeleton(false);
        // Use startTransition for non-blocking content show
        startTransition(() => {
          setTimeout(() => {
            setShowContent(true);
          }, 10);
        });
      }
      return () => void 0;
    }, [isLoading, showSkeleton]);

    // Memoize date groups calculation to prevent unnecessary recalculations
    const memoizedDateGroups = useMemo(() => {
      if (visibleSessions.length > 0) {
        return groupSessionsByDate(visibleSessions);
      }
      return [];
    }, [visibleSessions]);

    // Update date groups when filtered sessions change
    useEffect(() => {
      startTransition(() => {
        setDateGroups(memoizedDateGroups);
      });
    }, [memoizedDateGroups]);

    // Handle immediate search input (updates search term for debouncing).
    const handleSearch = useCallback((term: string) => {
      setSearchTerm(term);
    }, []);

    // Handle modal close
    const handleModalClose = useCallback(() => {
      setShowEditModal(false);
      setEditingSession(null);
    }, []);

    const handleModalSave = useCallback(async (sessionId: string, newDescription: string) => {
      // Update state immediately for optimistic UI
      setSessions((prevSessions) =>
        prevSessions.map((s) =>
          s.id === sessionId ? { ...s, name: newDescription, user_set_name: true } : s
        )
      );
      window.dispatchEvent(
        new CustomEvent(AppEvents.SESSION_RENAMED, {
          detail: { sessionId, newName: newDescription, userInitiated: true },
        })
      );
    }, []);

    const handleEditSession = useCallback((session: SessionListItem) => {
      setEditingSession(session);
      setShowEditModal(true);
    }, []);

    const handleDeleteSession = useCallback((session: SessionListItem) => {
      setSessionToDelete(session);
      setShowDeleteConfirmation(true);
    }, []);

    const handleArchiveSession = useCallback(
      async (session: SessionListItem) => {
        if (mutationRef.current) return;
        mutationRef.current = true;
        setArchivingSessionId(session.id);
        try {
          if (session.archivedAt) {
            await acpUnarchiveSession(session.id);
            toast.success(intl.formatMessage(i18n.unarchiveSuccess));
          } else {
            await acpArchiveSession(session.id);
            toast.success(intl.formatMessage(i18n.archiveSuccess));
          }
        } catch (error) {
          toast.error(
            intl.formatMessage(i18n.archiveFailed, {
              error: errorMessage(error, 'Unknown error'),
            })
          );
        } finally {
          mutationRef.current = false;
          setArchivingSessionId(null);
        }
      },
      [intl]
    );

    const handleDuplicateSession = useCallback(
      async (session: SessionListItem) => {
        if (!canForkSession(session.sessionType)) return;
        try {
          await acpForkSession(session.id);
          toast.success(intl.formatMessage(i18n.duplicateSuccess, { name: session.name }));
          window.dispatchEvent(new CustomEvent(AppEvents.SESSION_CREATED));
          await loadSessions();
        } catch (error) {
          console.error('Error duplicating session:', error);
          toast.error(
            intl.formatMessage(i18n.duplicateFailed, {
              error: errorMessage(error, 'Unknown error'),
            })
          );
        }
      },
      [loadSessions, intl]
    );

    const handleConfirmDelete = useCallback(async () => {
      if (!sessionToDelete || mutationRef.current) return;
      mutationRef.current = true;
      setDeleting(true);
      const sessionToDeleteId = sessionToDelete.id;
      const sessionName = sessionToDelete.name;

      try {
        await acpDeleteSession(sessionToDeleteId);
        toast.success(intl.formatMessage(i18n.deleteSuccess));
        window.dispatchEvent(
          new CustomEvent(AppEvents.SESSION_DELETED, { detail: { sessionId: sessionToDeleteId } })
        );
        cancelAcpPermissionRequestsForSession(sessionToDeleteId);
        cancelAcpElicitationRequestsForSession(sessionToDeleteId);
        acpChatSessionActions.deleteSnapshot(sessionToDeleteId);
        setShowDeleteConfirmation(false);
        setSessionToDelete(null);
      } catch (error) {
        console.error('Error deleting session:', error);
        toast.error(
          intl.formatMessage(i18n.deleteFailed, {
            name: sessionName,
            error: errorMessage(error, 'Unknown error'),
          })
        );
      } finally {
        mutationRef.current = false;
        setDeleting(false);
      }
    }, [sessionToDelete, intl]);

    const handleCancelDelete = useCallback(() => {
      if (mutationRef.current) return;
      setShowDeleteConfirmation(false);
      setSessionToDelete(null);
    }, []);

    const handleExportSession = useCallback(
      async (session: SessionListItem, e: React.MouseEvent) => {
        e.stopPropagation();

        if (session.archivedAt) return;
        try {
          const json = await acpExportSession(session.id);
          const blob = new Blob([json], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          try {
            a.href = url;
            a.download = `${session.name}.json`;
            document.body.appendChild(a);
            a.click();
          } finally {
            a.remove();
            URL.revokeObjectURL(url);
          }
          toast.success(intl.formatMessage(i18n.exportSuccess));
        } catch (error) {
          toast.error(
            intl.formatMessage(i18n.exportFailed, {
              error: errorMessage(error, 'Unknown error'),
            })
          );
        }
      },
      [intl]
    );

    const handleShareSessionNostr = useCallback(
      async (session: SessionListItem, e: React.MouseEvent) => {
        e.stopPropagation();
        setSharingSessionId(session.id);
        try {
          const response = await acpShareSessionNostr(session.id, []);
          setShareLink(toPrimaryDeepLink(response.deeplink));
          setShowShareLinkModal(true);
          toast.success(intl.formatMessage(i18n.shareNostrSuccess));
        } catch (error) {
          toast.error(
            intl.formatMessage(i18n.shareNostrFailed, {
              error: errorMessage(error, 'Unknown error'),
            })
          );
        } finally {
          setSharingSessionId(null);
        }
      },
      [intl]
    );

    const handleImportClick = useCallback(async () => {
      const native = window.electron?.selectImportSessionFile;
      if (typeof native === 'function') {
        try {
          const result = await native();
          if (!result) return;
          if (result.error) {
            toast.error(intl.formatMessage(i18n.importFailed, { error: result.error }));
            return;
          }
          await acpImportSession(result.contents, 'json');
          toast.success(intl.formatMessage(i18n.importSuccess));
          window.dispatchEvent(new CustomEvent(AppEvents.SESSION_CREATED));
          await loadSessions();
        } catch (error) {
          toast.error(
            intl.formatMessage(i18n.importFailed, { error: errorMessage(error, 'Unknown error') })
          );
        }
        return;
      }
      // Fallback for non-Electron contexts (tests, web build).
      fileInputRef.current?.click();
    }, [intl, loadSessions]);

    const handleImportNostrLink = useCallback(async () => {
      const deeplink = nostrImportLink.trim();
      if (!deeplink) return;

      setIsImportingNostr(true);
      try {
        await acpImportSession(deeplink, 'nostr');
        setNostrImportLink('');
        setShowImportLinkModal(false);
        toast.success(intl.formatMessage(i18n.importSuccess));
        window.dispatchEvent(new CustomEvent(AppEvents.SESSION_CREATED));
        await loadSessions();
      } catch (error) {
        toast.error(
          intl.formatMessage(i18n.importFailed, { error: errorMessage(error, 'Unknown error') })
        );
      } finally {
        setIsImportingNostr(false);
      }
    }, [intl, loadSessions, nostrImportLink]);

    const handleCopyShareLink = useCallback(async () => {
      try {
        await navigator.clipboard.writeText(shareLink);
        toast.success(intl.formatMessage(i18n.copied));
      } catch (error) {
        toast.error(`Failed to copy: ${errorMessage(error, 'Unknown error')}`);
      }
    }, [intl, shareLink]);

    const handleImportSession = useCallback(
      async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
          const json = await file.text();
          await acpImportSession(json, 'json');

          toast.success(intl.formatMessage(i18n.importSuccess));
          window.dispatchEvent(new CustomEvent(AppEvents.SESSION_CREATED));
          await loadSessions();
        } catch (error) {
          toast.error(intl.formatMessage(i18n.importFailed, { error: String(error) }));
        } finally {
          if (fileInputRef.current) {
            fileInputRef.current.value = '';
          }
        }
      },
      [loadSessions, intl]
    );

    const handleOpenInNewWindow = useCallback((session: SessionListItem, e: React.MouseEvent) => {
      e.stopPropagation();
      window.electron.createChatWindow({
        dir: session.workingDir,
        resumeSessionId: session.id,
        viewType: 'pair',
      });
    }, []);

    const SessionItem = React.memo(function SessionItem({
      session,
      onEditClick,
      onDuplicateClick,
      onArchiveClick,
      onDeleteClick,
      onExportClick,
      onShareClick,
      onOpenInNewWindow,
      isSharing,
      isArchiving,
    }: {
      session: SessionListItem;
      onEditClick: (session: SessionListItem) => void;
      onDuplicateClick: (session: SessionListItem) => void;
      onArchiveClick: (session: SessionListItem) => void;
      onDeleteClick: (session: SessionListItem) => void;
      onExportClick: (session: SessionListItem, e: React.MouseEvent) => void;
      onShareClick: (session: SessionListItem, e: React.MouseEvent) => void;
      onOpenInNewWindow: (session: SessionListItem, e: React.MouseEvent) => void;
      isSharing: boolean;
      isArchiving: boolean;
    }) {
      const handleEditClick = useCallback(
        (e: React.MouseEvent) => {
          e.stopPropagation();
          onEditClick(session);
        },
        [onEditClick, session]
      );

      const handleDuplicateClick = useCallback(
        (e: React.MouseEvent) => {
          e.stopPropagation();
          onDuplicateClick(session);
        },
        [onDuplicateClick, session]
      );

      const handleDeleteClick = useCallback(
        (e: React.MouseEvent) => {
          e.stopPropagation();
          onDeleteClick(session);
        },
        [onDeleteClick, session]
      );

      const handleArchiveClick = useCallback(
        (e: React.MouseEvent) => {
          e.stopPropagation();
          onArchiveClick(session);
        },
        [onArchiveClick, session]
      );

      const handleCardClick = useCallback(() => {
        if (!session.archivedAt) onSelectSession(session.id);
      }, [session.id, session.archivedAt]);

      const handleExportClick = useCallback(
        (e: React.MouseEvent) => {
          onExportClick(session, e);
        },
        [onExportClick, session]
      );

      const handleShareClick = useCallback(
        (e: React.MouseEvent) => {
          onShareClick(session, e);
        },
        [onShareClick, session]
      );

      const handleOpenInNewWindowClick = useCallback(
        (e: React.MouseEvent) => {
          onOpenInNewWindow(session, e);
        },
        [onOpenInNewWindow, session]
      );

      const displayName = session.name;

      return (
        <article className="flex min-w-0 flex-wrap items-center gap-3 border-b border-border-primary px-4 py-3 last:border-b-0 hover:bg-background-secondary/40">
          <div className="min-w-0 flex-1 basis-48">
            <button
              onClick={handleCardClick}
              disabled={Boolean(session.archivedAt)}
              className="block max-w-full truncate text-left text-sm font-medium text-text-primary disabled:cursor-default hover:underline disabled:no-underline"
              title={displayName}
            >
              {displayName}
            </button>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
              <span>{formatMessageTimestamp(Date.parse(sessionActivityAt(session)) / 1000)}</span>
              {historyView !== 'archived' && (
                <span className="max-w-64 truncate" title={session.workingDir}>
                  {session.workingDir}
                </span>
              )}
              {session.archivedAt && historyView !== 'archived' && (
                <span className="rounded bg-background-tertiary px-1.5 py-0.5">
                  {intl.formatMessage(i18n.archivedSessions)}
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleArchiveClick}
              disabled={Boolean(archivingSessionId) || deleting}
              title={intl.formatMessage(
                session.archivedAt ? i18n.unarchiveSession : i18n.archiveSession
              )}
            >
              {isArchiving ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : session.archivedAt ? (
                <ArchiveRestore className="size-3.5" />
              ) : (
                <Archive className="size-3.5" />
              )}
              {intl.formatMessage(session.archivedAt ? i18n.restore : i18n.archiveSession)}
            </Button>
            {session.archivedAt ? (
              <button
                onClick={handleDeleteClick}
                disabled={Boolean(archivingSessionId) || deleting}
                className="flex size-8 items-center justify-center rounded-md text-text-secondary hover:bg-red-50 hover:text-red-600 focus-visible:ring-2 disabled:opacity-50"
                title={intl.formatMessage(i18n.permanentDelete)}
                aria-label={intl.formatMessage(i18n.permanentDelete)}
              >
                <Trash2 className="size-4" />
              </button>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className="flex size-8 items-center justify-center rounded-md text-text-secondary hover:bg-background-tertiary"
                    aria-label={intl.formatMessage(i18n.more, { name: displayName })}
                  >
                    <MoreHorizontal className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={handleOpenInNewWindowClick}
                    title={intl.formatMessage(i18n.openInNewWindow)}
                  >
                    <ExternalLink />
                    {intl.formatMessage(i18n.openInNewWindow)}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={handleEditClick}
                    title={intl.formatMessage(i18n.editSessionName)}
                  >
                    <Edit2 />
                    {intl.formatMessage(i18n.editSessionName)}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={handleDuplicateClick}
                    disabled={!canForkSession(session.sessionType)}
                    title={intl.formatMessage(
                      canForkSession(session.sessionType)
                        ? i18n.duplicateSession
                        : sessionCapabilityMessages.forkUnavailable
                    )}
                  >
                    <Copy />
                    {intl.formatMessage(i18n.duplicateSession)}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={handleExportClick}
                    title={intl.formatMessage(i18n.exportSession)}
                  >
                    <Download />
                    {intl.formatMessage(i18n.exportSession)}
                  </DropdownMenuItem>
                  {nostrEnabled && (
                    <DropdownMenuItem
                      onClick={handleShareClick}
                      disabled={isSharing}
                      title={intl.formatMessage(i18n.shareNostrSession)}
                    >
                      <Share2 />
                      {intl.formatMessage(i18n.shareNostrSession)}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onClick={handleDeleteClick}
                    disabled={Boolean(archivingSessionId) || deleting}
                    variant="destructive"
                    title={intl.formatMessage(i18n.permanentDelete)}
                  >
                    <Trash2 />
                    {intl.formatMessage(i18n.permanentDelete)}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </article>
      );
    });

    const renderActualContent = () => {
      if (error) {
        return (
          <div className="flex flex-col items-center justify-center h-full text-text-secondary">
            <AlertCircle className="h-12 w-12 text-red-500 mb-4" />
            <p className="text-lg mb-2">{intl.formatMessage(i18n.errorLoading)}</p>
            <p className="text-sm text-center mb-4">{error}</p>
            <Button onClick={() => loadSessions(debouncedSearchTerm)} variant="default">
              {intl.formatMessage(i18n.tryAgain)}
            </Button>
          </div>
        );
      }

      if (visibleSessions.length === 0) {
        if (
          historyView === 'archived' &&
          !debouncedSearchTerm &&
          projectFilter === 'all' &&
          dateFilter === 'all'
        ) {
          return (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-text-secondary">
              <Archive className="mb-2 size-8" />
              <p className="font-medium text-text-primary">
                {intl.formatMessage(i18n.archiveEmpty)}
              </p>
              <p className="max-w-sm text-sm">{intl.formatMessage(i18n.archiveEmptyDescription)}</p>
            </div>
          );
        }
        // `sessions` holds the keyword-filtered set, so an empty result while searching
        // means "no matches" rather than "no sessions at all".
        if (debouncedSearchTerm || hasManagementFilter) {
          return (
            <div className="flex flex-col items-center justify-center h-full text-text-secondary mt-4">
              <MessageSquareText className="h-12 w-12 mb-4" />
              <p className="text-lg mb-2">{intl.formatMessage(i18n.noMatching)}</p>
              <p className="text-sm">{intl.formatMessage(i18n.noMatchingDesc)}</p>
            </div>
          );
        }
        return (
          <div className="flex flex-col justify-center h-full text-text-secondary">
            <MessageSquareText className="h-12 w-12 mb-4" />
            <p className="text-lg mb-2">{intl.formatMessage(i18n.noSessions)}</p>
            <p className="text-sm">{intl.formatMessage(i18n.noSessionsDesc)}</p>
          </div>
        );
      }

      return (
        <div className="space-y-8">
          {(historyView === 'archived'
            ? archiveGroups.map((group) => ({
                ...group,
                label:
                  group.path.split(/[\\/]/).filter(Boolean).pop() ||
                  intl.formatMessage(i18n.noProject),
              }))
            : visibleDateGroups.map((group) => ({ ...group, path: group.label }))
          ).map((group) => (
            <section key={group.path} className="space-y-2">
              <div className="flex min-w-0 items-center gap-2 px-1 text-sm text-text-secondary">
                {historyView === 'archived' && <Folder className="size-4 shrink-0" />}
                <h2 className="truncate font-medium" title={group.path}>
                  {group.label}
                </h2>
                <span className="ml-auto shrink-0 text-xs">
                  {intl.formatMessage(i18n.count, { count: group.sessions.length })}
                </span>
              </div>
              <div className="overflow-hidden rounded-xl border border-border-primary bg-background-primary">
                {group.sessions.map((session) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    onEditClick={handleEditSession}
                    onDuplicateClick={handleDuplicateSession}
                    onArchiveClick={handleArchiveSession}
                    onDeleteClick={handleDeleteSession}
                    onExportClick={handleExportSession}
                    onShareClick={handleShareSessionNostr}
                    onOpenInNewWindow={handleOpenInNewWindow}
                    isSharing={sharingSessionId === session.id}
                    isArchiving={archivingSessionId === session.id}
                  />
                ))}
              </div>
            </section>
          ))}

          {isPrefetchingSessions && (
            <div className="flex justify-center py-8">
              <div className="flex items-center space-x-2 text-text-secondary">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2"></div>
                <span>{intl.formatMessage(i18n.loadingMore)}</span>
              </div>
            </div>
          )}
        </div>
      );
    };

    return (
      <>
        <MainPanelLayout>
          <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col min-h-0">
            <div className="bg-background-primary px-4 pb-5 pt-8 sm:px-8">
              <div className="flex flex-col page-transition">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
                  <h1 className="text-2xl font-semibold tracking-tight">
                    {workspaceMode === 'unified'
                      ? null
                      : workspaceMode === 'codepro'
                        ? 'CodePro '
                        : 'Code '}
                    {intl.formatMessage(i18n.chatHistory)}
                  </h1>
                  <div className="flex items-center gap-2">
                    {nostrEnabled && (
                      <Button
                        onClick={() => setShowImportLinkModal(true)}
                        variant="outline"
                        size="sm"
                        className="flex items-center gap-2"
                      >
                        <Share2 className="w-4 h-4" />
                        {intl.formatMessage(i18n.importNostrSession)}
                      </Button>
                    )}
                    <Button
                      onClick={handleImportClick}
                      variant="outline"
                      size="sm"
                      className="flex items-center gap-2"
                    >
                      <Upload className="w-4 h-4" />
                      {intl.formatMessage(i18n.importSession)}
                    </Button>
                  </div>
                </div>
                <p className="text-sm text-text-secondary mb-4">
                  {intl.formatMessage(i18n.description)}
                </p>
                <div className="mb-4 flex items-start gap-2 rounded-lg bg-background-secondary px-3 py-2.5 text-sm text-text-secondary">
                  <Archive className="mt-0.5 size-4 shrink-0" />
                  <p>{intl.formatMessage(i18n.archiveNotice)}</p>
                </div>
                <label className="mb-4 flex items-center gap-2 rounded-lg border border-border-primary px-3 py-2 text-text-secondary focus-within:ring-1 focus-within:ring-border-active">
                  <Search className="size-4 shrink-0" />
                  <input
                    ref={searchInputRef}
                    type="search"
                    value={searchTerm}
                    onChange={(event) => handleSearch(event.target.value)}
                    aria-label={intl.formatMessage(i18n.searchPlaceholder)}
                    placeholder={intl.formatMessage(i18n.searchPlaceholder)}
                    className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none"
                  />
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <div
                    role="tablist"
                    aria-label={intl.formatMessage(i18n.historyView)}
                    className="mr-auto flex max-w-full items-center gap-1 rounded-lg bg-background-secondary p-1"
                  >
                    {(['active', 'archived', 'all'] as const).map((view) => (
                      <button
                        key={view}
                        role="tab"
                        aria-selected={historyView === view}
                        id={`history-tab-${view}`}
                        aria-controls="history-results"
                        tabIndex={historyView === view ? 0 : -1}
                        onKeyDown={(event) => {
                          const tabs = ['active', 'archived', 'all'] as const;
                          const index = tabs.indexOf(view);
                          const next =
                            event.key === 'ArrowRight'
                              ? (index + 1) % tabs.length
                              : event.key === 'ArrowLeft'
                                ? (index + tabs.length - 1) % tabs.length
                                : event.key === 'Home'
                                  ? 0
                                  : event.key === 'End'
                                    ? tabs.length - 1
                                    : -1;
                          if (next < 0) return;
                          event.preventDefault();
                          setHistoryView(tabs[next]);
                          setVisibleGroupsCount(15);
                          (
                            event.currentTarget.parentElement?.children[next] as HTMLButtonElement
                          )?.focus();
                        }}
                        onClick={() => {
                          setHistoryView(view);
                          setVisibleGroupsCount(15);
                        }}
                        className={`rounded-md px-3 py-1.5 text-sm transition-colors ${historyView === view ? 'bg-background-primary font-medium text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'}`}
                      >
                        {intl.formatMessage(
                          view === 'active'
                            ? i18n.conversations
                            : view === 'archived'
                              ? i18n.archivedSessions
                              : i18n.allSessions
                        )}
                      </button>
                    ))}
                  </div>
                  <select
                    aria-label={intl.formatMessage(i18n.projectFilter)}
                    value={projectFilter}
                    onChange={(event) => setProjectFilter(event.target.value)}
                    className="max-w-80 rounded-md border border-border-primary bg-background-primary px-3 py-2 text-sm text-text-primary"
                  >
                    <option value="all">{intl.formatMessage(i18n.allProjects)}</option>
                    {projectOptions.map((workingDir) => (
                      <option key={workingDir} value={workingDir}>
                        {workingDir || intl.formatMessage(i18n.noProject)}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={intl.formatMessage(i18n.dateFilter)}
                    value={dateFilter}
                    onChange={(event) => setDateFilter(event.target.value as HistoryDateFilter)}
                    className="rounded-md border border-border-primary bg-background-primary px-3 py-2 text-sm text-text-primary"
                  >
                    <option value="all">{intl.formatMessage(i18n.allDates)}</option>
                    <option value="today">{intl.formatMessage(i18n.today)}</option>
                    <option value="7d">{intl.formatMessage(i18n.lastSevenDays)}</option>
                    <option value="30d">{intl.formatMessage(i18n.lastThirtyDays)}</option>
                  </select>
                </div>
              </div>
            </div>

            <div
              id="history-results"
              role="tabpanel"
              aria-labelledby={`history-tab-${historyView}`}
              className="flex-1 min-h-0 relative"
            >
              <ScrollArea handleScroll={handleScroll} className="h-full" data-search-scroll-area>
                <div ref={containerRef} className="h-full relative px-4 sm:px-8">
                  <div className="relative pb-8">
                    {/* Skeleton layer - always rendered but conditionally visible */}
                    <div
                      className={`absolute inset-0 transition-opacity duration-300 ${
                        isLoading || showSkeleton
                          ? 'opacity-100 z-10'
                          : 'opacity-0 z-0 pointer-events-none'
                      }`}
                    >
                      <div
                        className="overflow-hidden rounded-xl border border-border-primary"
                        aria-hidden="true"
                      >
                        {Array.from({ length: 5 }, (_, index) => (
                          <div
                            key={index}
                            className="flex items-center justify-between gap-4 border-b border-border-primary p-4 last:border-b-0"
                          >
                            <div className="flex-1 space-y-2">
                              <Skeleton className="h-4 w-2/3" />
                              <Skeleton className="h-3 w-28" />
                            </div>
                            <Skeleton className="h-8 w-20" />
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Content layer - always rendered but conditionally visible */}
                    <div
                      className={`relative transition-opacity duration-300 ${
                        showContent ? 'opacity-100 z-10' : 'opacity-0 z-0'
                      }`}
                    >
                      {renderActualContent()}
                    </div>
                  </div>
                </div>
              </ScrollArea>
            </div>
          </div>
        </MainPanelLayout>

        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.jsonl,application/json,application/x-ndjson"
          onChange={handleImportSession}
          className="hidden"
        />

        <EditSessionModal
          session={editingSession}
          isOpen={showEditModal}
          onClose={handleModalClose}
          onSave={handleModalSave}
        />

        <Dialog open={showImportLinkModal} onOpenChange={setShowImportLinkModal}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Share2 className="w-5 h-5" />
                {intl.formatMessage(i18n.importNostrTitle)}
              </DialogTitle>
              <DialogDescription>{intl.formatMessage(i18n.importNostrDesc)}</DialogDescription>
            </DialogHeader>

            <textarea
              value={nostrImportLink}
              onChange={(event) => setNostrImportLink(event.target.value)}
              placeholder={intl.formatMessage(i18n.importNostrPlaceholder)}
              className="min-h-28 w-full resize-none rounded-lg border border-border-primary bg-background-primary p-3 text-sm text-text-primary outline-none focus:ring-2 focus:ring-border-active"
              disabled={isImportingNostr}
            />

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowImportLinkModal(false)}
                disabled={isImportingNostr}
              >
                {intl.formatMessage(i18n.cancel)}
              </Button>
              <Button
                onClick={handleImportNostrLink}
                disabled={isImportingNostr || !nostrImportLink.trim()}
              >
                {isImportingNostr ? (
                  <>
                    <LoaderCircle className="w-4 h-4 animate-spin" />
                    {intl.formatMessage(i18n.importing)}
                  </>
                ) : (
                  intl.formatMessage(i18n.importSession)
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={showShareLinkModal} onOpenChange={setShowShareLinkModal}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Share2 className="w-5 h-5" />
                {intl.formatMessage(i18n.shareNostrTitle)}
              </DialogTitle>
              <DialogDescription>{intl.formatMessage(i18n.shareNostrDesc)}</DialogDescription>
            </DialogHeader>

            <div className="relative rounded-lg border border-border-primary bg-background-secondary p-3 pr-12">
              <code className="block max-h-36 overflow-y-auto break-all text-sm text-text-primary">
                {shareLink}
              </code>
              <Button
                variant="ghost"
                size="sm"
                className="absolute right-2 top-2"
                onClick={handleCopyShareLink}
                disabled={!shareLink}
              >
                <Copy className="h-4 w-4" />
                <span className="sr-only">{intl.formatMessage(i18n.copied)}</span>
              </Button>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setShowShareLinkModal(false)}>
                {intl.formatMessage(i18n.close)}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <ConfirmationModal
          isOpen={showDeleteConfirmation}
          title={intl.formatMessage(i18n.deleteTitle)}
          message={intl.formatMessage(i18n.deleteMessage, { name: sessionToDelete?.name ?? '' })}
          confirmLabel={intl.formatMessage(i18n.deleteTitle)}
          cancelLabel={intl.formatMessage(i18n.cancel)}
          confirmVariant="destructive"
          isSubmitting={deleting}
          onConfirm={handleConfirmDelete}
          onCancel={handleCancelDelete}
        />
      </>
    );
  }
);

SessionListView.displayName = 'SessionListView';

export default SessionListView;
