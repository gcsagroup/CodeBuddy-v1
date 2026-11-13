import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  GitBranch,
  Pin,
  PinOff,
  Archive,
  Trash2,
  Download,
  FolderOpen,
  Edit2,
  FileJson,
  LoaderCircle,
} from 'lucide-react';
import { toast } from 'react-toastify';
import { setSessionPinned, useSessionPins } from '../utils/sessionPins';
import { AppEvents } from '../constants/events';
import { defineMessages, useIntl } from '../i18n';
import {
  acpArchiveSession,
  acpDeleteSession,
  acpExportSession,
  acpExportSessionLog,
  acpForkSession,
  acpRenameSession,
} from '../acp/sessions';
import { errorMessage } from '../utils/conversionUtils';
import { ConfirmationModal } from './ui/ConfirmationModal';
import { acpChatSessionActions } from '../acp/chatSessionStore';
import { cancelAcpPermissionRequestsForSession } from '../acp/permissionRequests';
import { cancelAcpElicitationRequestsForSession } from '../acp/elicitationRequests';
import type { SessionType } from '../types/session';
import { canForkSession, sessionCapabilityMessages } from '../utils/sessionCapabilities';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

const i18n = defineMessages({
  delete: { id: 'sessions.action.delete', defaultMessage: 'Delete session' },
  deleteTitle: { id: 'sessions.history.deleteTitle', defaultMessage: 'Permanently delete conversation' },
  deleteMessage: { id: 'sessions.history.deleteMessage', defaultMessage: 'Permanently remove "{name}" from your conversation history? You cannot restore it in CodeBuddy. Files in the workspace will be kept.' },
  deleted: { id: 'sessions.toast.deleted', defaultMessage: 'Session deleted successfully' },
  deleteFailed: { id: 'sessions.toast.deleteFailed', defaultMessage: 'Failed to delete session "{name}": {error}' },
  cancelDelete: { id: 'markdownContent.cancel', defaultMessage: 'Cancel' },
  pin: { id: 'sessionActions.pin', defaultMessage: 'Pin session' },
  unpin: { id: 'sessionActions.unpin', defaultMessage: 'Unpin session' },
  pinFailed: {
    id: 'sessionActions.pinFailed',
    defaultMessage: 'Could not save pin preference: {error}',
  },
  branchHint: {
    id: 'sessionActions.branchHint',
    defaultMessage:
      'Continue in an independent conversation. Files remain shared; running tasks are not copied.',
  },
  exportLogWriteFailed: {
    id: 'sessionActionsHeader.exportLogWriteFailed',
    defaultMessage: 'The log file could not be saved.',
  },
  exportLogNotice: {
    id: 'sessionActionsHeader.exportLogNotice',
    defaultMessage: 'Exports event order, status and safe error categories only. Conversation content, tool data and the complete history stay on this computer. This diagnostic file cannot restore a conversation.',
  },
  exportLogSaved: {
    id: 'sessionActionsHeader.exportLogSaved',
    defaultMessage: 'Session diagnostics saved',
  },
  exportLogFailed: {
    id: 'sessionActionsHeader.exportLogFailed',
    defaultMessage: 'Session diagnostics could not be saved. The complete history remains on this computer. Please try again.',
  },
  exportLog: { id: 'sessionActionsHeader.exportLog', defaultMessage: 'Export diagnostics' },
  openFolder: { id: 'sessionActionsHeader.openFolder', defaultMessage: 'Open folder' },
  openFolderFailed: {
    id: 'sessionActionsHeader.openFolderFailed',
    defaultMessage: 'Unable to open the session folder: {error}',
  },
  copySessionId: { id: 'sessionActionsHeader.copySessionId', defaultMessage: 'Copy session ID' },
  copiedSessionId: {
    id: 'sessionActionsHeader.copiedSessionId',
    defaultMessage: 'Session ID copied',
  },
  copySessionIdFailed: {
    id: 'sessionActionsHeader.copySessionIdFailed',
    defaultMessage: 'Unable to copy session ID: {error}',
  },
  archive: { id: 'sessions.action.archive', defaultMessage: 'Archive session' },
  archived: { id: 'sessions.toast.archived', defaultMessage: 'Session archived' },
  archiveFailed: {
    id: 'sessions.toast.archiveFailed',
    defaultMessage: 'Failed to update session archive: {error}',
  },
  export: { id: 'sessions.action.export', defaultMessage: 'Export session' },
  exported: { id: 'sessions.toast.exported', defaultMessage: 'Session exported successfully' },
  exportFailed: {
    id: 'sessions.toast.exportFailed',
    defaultMessage: 'Failed to export session: {error}',
  },
  actionsLabel: {
    id: 'sessionActionsHeader.actionsLabel',
    defaultMessage: 'Session actions',
  },
  renameSession: {
    id: 'sessionActionsHeader.renameSession',
    defaultMessage: 'Rename session',
  },
  duplicateSession: {
    id: 'sessionActionsHeader.duplicateSession',
    defaultMessage: 'Branch conversation',
  },
  viewJson: {
    id: 'sessionActionsHeader.viewJson',
    defaultMessage: 'View session JSON',
  },
  renameTitle: {
    id: 'sessionActionsHeader.renameTitle',
    defaultMessage: 'Rename Session',
  },
  renamePlaceholder: {
    id: 'sessionActionsHeader.renamePlaceholder',
    defaultMessage: 'Enter session name',
  },
  cancel: {
    id: 'sessionActionsHeader.cancel',
    defaultMessage: 'Cancel',
  },
  save: {
    id: 'sessionActionsHeader.save',
    defaultMessage: 'Save',
  },
  saving: {
    id: 'sessionActionsHeader.saving',
    defaultMessage: 'Saving...',
  },
  renamed: {
    id: 'sessionActionsHeader.renamed',
    defaultMessage: 'Session renamed',
  },
  renameFailed: {
    id: 'sessionActionsHeader.renameFailed',
    defaultMessage: 'Failed to rename session: {error}',
  },
  duplicated: {
    id: 'sessionActionsHeader.duplicated',
    defaultMessage: 'Conversation branch created',
  },
  duplicateFailed: {
    id: 'sessionActionsHeader.duplicateFailed',
    defaultMessage: 'Failed to branch conversation: {error}',
  },
  jsonTitle: {
    id: 'sessionActionsHeader.jsonTitle',
    defaultMessage: 'Session JSON',
  },
  loadingJson: {
    id: 'sessionActionsHeader.loadingJson',
    defaultMessage: 'Loading JSON...',
  },
  jsonFailed: {
    id: 'sessionActionsHeader.jsonFailed',
    defaultMessage: 'Failed to load session JSON: {error}',
  },
  close: {
    id: 'sessionActionsHeader.close',
    defaultMessage: 'Close',
  },
  copyJson: {
    id: 'sessionActionsHeader.copyJson',
    defaultMessage: 'Copy JSON',
  },
  copiedJson: {
    id: 'sessionActionsHeader.copiedJson',
    defaultMessage: 'Session JSON copied',
  },
  fullTextTitle: {
    id: 'sessionActionsHeader.fullTextTitle',
    defaultMessage: 'Text value',
  },
  copyText: {
    id: 'sessionActionsHeader.copyText',
    defaultMessage: 'Copy text',
  },
  copiedText: {
    id: 'sessionActionsHeader.copiedText',
    defaultMessage: 'Text copied',
  },
});

const LONG_STRING_THRESHOLD = 180;
const STRING_PREVIEW_START = 96;
const STRING_PREVIEW_END = 56;

interface SessionActionsContextMenuProps {
  session: { id: string; name: string; workingDir?: string; sessionType?: SessionType };
  children: ReactNode;
  onSessionRenamed?: () => void;
  onSessionForked?: (id: string) => void;
}

interface ParsedSessionJson {
  value: unknown;
  pretty: string;
}

interface FullTextSelection {
  path: string;
  value: string;
}

function parseSessionJson(json: string): ParsedSessionJson {
  const value = JSON.parse(json) as unknown;
  return {
    value,
    pretty: JSON.stringify(value, null, 2),
  };
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getNodePath(parentPath: string, key: string, isArrayItem: boolean): string {
  if (isArrayItem) {
    return `${parentPath}[${key}]`;
  }

  return /^[A-Za-z_$][\w$]*$/.test(key)
    ? `${parentPath}.${key}`
    : `${parentPath}[${JSON.stringify(key)}]`;
}

function getStringPreview(value: string): string {
  if (value.length <= LONG_STRING_THRESHOLD) {
    return JSON.stringify(value);
  }

  return JSON.stringify(
    `${value.slice(0, STRING_PREVIEW_START)} ... ${value.slice(-STRING_PREVIEW_END)}`
  );
}

function JsonPrimitiveValue({
  value,
  path,
  onOpenText,
}: {
  value: unknown;
  path: string;
  onOpenText: (selection: FullTextSelection) => void;
}) {
  if (typeof value === 'string') {
    const isLong = value.length > LONG_STRING_THRESHOLD;
    const preview = getStringPreview(value);

    if (isLong) {
      return (
        <button
          type="button"
          className="min-w-0 rounded-sm text-left text-blue-600 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-active dark:text-blue-300 break-all"
          onClick={() => onOpenText({ path, value })}
          title={path}
        >
          {preview}
        </button>
      );
    }

    return (
      <span className="min-w-0 text-emerald-700 dark:text-emerald-300 break-all">{preview}</span>
    );
  }

  if (typeof value === 'number') {
    return <span className="text-purple-700 dark:text-purple-300">{value}</span>;
  }

  if (typeof value === 'boolean') {
    return <span className="text-amber-700 dark:text-amber-300">{String(value)}</span>;
  }

  if (value === null) {
    return <span className="text-text-secondary">null</span>;
  }

  return <span className="text-text-secondary">{String(value)}</span>;
}

function JsonTreeNode({
  label,
  value,
  depth,
  path,
  isArrayItem = false,
  onOpenText,
}: {
  label?: string;
  value: unknown;
  depth: number;
  path: string;
  isArrayItem?: boolean;
  onOpenText: (selection: FullTextSelection) => void;
}) {
  const isArray = Array.isArray(value);
  const isRecord = isJsonRecord(value);
  const isContainer = isArray || isRecord;
  const [isOpen, setIsOpen] = useState(depth < 3);

  const labelNode =
    label === undefined ? null : (
      <span className="text-text-secondary">{isArrayItem ? label : JSON.stringify(label)}:</span>
    );

  if (!isContainer) {
    return (
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-1 px-1 py-0.5">
        {labelNode}
        <JsonPrimitiveValue value={value} path={path} onOpenText={onOpenText} />
      </div>
    );
  }

  const entries = isArray
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value);
  const openToken = isArray ? '[' : '{';
  const closeToken = isArray ? ']' : '}';
  const countLabel = isArray
    ? `${entries.length} ${entries.length === 1 ? 'item' : 'items'}`
    : `${entries.length} ${entries.length === 1 ? 'key' : 'keys'}`;

  return (
    <div className="min-w-0">
      <button
        type="button"
        className="flex max-w-full items-baseline gap-1 rounded-sm px-1 py-0.5 text-left transition-colors hover:bg-background-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-active"
        onClick={() => entries.length > 0 && setIsOpen((open) => !open)}
      >
        {entries.length > 0 ? (
          isOpen ? (
            <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-text-secondary" />
          ) : (
            <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-text-secondary" />
          )
        ) : (
          <span className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex flex-wrap items-baseline gap-x-1">
          {labelNode}
          <span>{openToken}</span>
          {!isOpen && entries.length > 0 && (
            <span className="text-text-secondary">{countLabel}</span>
          )}
          {(!isOpen || entries.length === 0) && <span>{closeToken}</span>}
        </span>
      </button>

      {isOpen && entries.length > 0 && (
        <div className="ml-3 border-l border-border-primary/70 pl-3">
          {entries.map(([key, childValue]) => (
            <JsonTreeNode
              key={`${path}.${key}`}
              label={key}
              value={childValue}
              depth={depth + 1}
              path={getNodePath(path, key, isArray)}
              isArrayItem={isArray}
              onOpenText={onOpenText}
            />
          ))}
          <div className="px-1 py-0.5">{closeToken}</div>
        </div>
      )}
    </div>
  );
}

function JsonTree({
  value,
  onOpenText,
}: {
  value: unknown;
  onOpenText: (selection: FullTextSelection) => void;
}) {
  return (
    <div className="min-w-0 font-mono text-xs leading-5 text-text-primary">
      <JsonTreeNode value={value} depth={0} path="root" onOpenText={onOpenText} />
    </div>
  );
}

export function SessionActionsContextMenu({
  session,
  children,
  onSessionRenamed,
  onSessionForked,
}: SessionActionsContextMenuProps) {
  const intl = useIntl();
  const pins = useSessionPins();
  const pinned = pins.includes(session.id);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);
  const [isJsonOpen, setIsJsonOpen] = useState(false);
  const [jsonValue, setJsonValue] = useState<unknown>(null);
  const [jsonText, setJsonText] = useState('');
  const [isJsonLoading, setIsJsonLoading] = useState(false);
  const [isExportingLog, setIsExportingLog] = useState(false);
  const exportingLog = useRef(false);
  const [isDuplicating, setIsDuplicating] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<typeof session | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const deleting = useRef(false);
  const [isExporting, setIsExporting] = useState(false);
  const [fullTextSelection, setFullTextSelection] = useState<FullTextSelection | null>(null);
  const jsonLoadRequestId = useRef(0);

  useEffect(() => {
    if (session && isRenameOpen) {
      setRenameValue(session.name);
    }
  }, [isRenameOpen, session]);

  const handleRename = useCallback(async () => {
    if (!session || isRenaming) return;

    const trimmedName = renameValue.trim();
    if (!trimmedName) return;

    if (trimmedName === session.name) {
      setIsRenameOpen(false);
      return;
    }

    setIsRenaming(true);
    try {
      await acpRenameSession(session.id, trimmedName);
      onSessionRenamed?.();
      window.dispatchEvent(
        new CustomEvent(AppEvents.SESSION_RENAMED, {
          detail: { sessionId: session.id, newName: trimmedName, userInitiated: true },
        })
      );
      setIsRenameOpen(false);
      toast.success(intl.formatMessage(i18n.renamed));
    } catch (error) {
      toast.error(
        intl.formatMessage(i18n.renameFailed, {
          error: errorMessage(error, 'Unknown error'),
        })
      );
    } finally {
      setIsRenaming(false);
    }
  }, [intl, isRenaming, onSessionRenamed, renameValue, session]);

  const handleDuplicate = useCallback(async () => {
    if (!session || isDuplicating || !canForkSession(session.sessionType)) return;

    setIsDuplicating(true);
    try {
      const id = await acpForkSession(session.id);
      onSessionForked?.(id);
      window.dispatchEvent(new CustomEvent(AppEvents.SESSION_CREATED));
      toast.success(intl.formatMessage(i18n.duplicated));
    } catch (error) {
      toast.error(
        intl.formatMessage(i18n.duplicateFailed, {
          error: errorMessage(error, 'Unknown error'),
        })
      );
    } finally {
      setIsDuplicating(false);
    }
  }, [intl, isDuplicating, session, onSessionForked]);

  const handleOpenFolder = async () => {
    if (!session.workingDir) return;
    try {
      if (!(await window.electron.openDirectoryInExplorer(session.workingDir))) {
        throw new Error(session.workingDir);
      }
    } catch (error) {
      toast.error(intl.formatMessage(i18n.openFolderFailed, { error: errorMessage(error) }));
    }
  };

  const handleCopySessionId = async () => {
    try {
      await navigator.clipboard.writeText(session.id);
      toast.success(intl.formatMessage(i18n.copiedSessionId));
    } catch (error) {
      toast.error(intl.formatMessage(i18n.copySessionIdFailed, { error: errorMessage(error) }));
    }
  };

  const handleArchive = async () => {
    if (isArchiving) return;
    setIsArchiving(true);
    try {
      await acpArchiveSession(session.id);
      toast.success(intl.formatMessage(i18n.archived));
    } catch (error) {
      toast.error(intl.formatMessage(i18n.archiveFailed, { error: errorMessage(error) }));
    } finally {
      setIsArchiving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget || deleting.current) return;
    const target = deleteTarget;
    deleting.current = true;
    setIsDeleting(true);
    try {
      await acpDeleteSession(target.id);
      cancelAcpPermissionRequestsForSession(target.id);
      cancelAcpElicitationRequestsForSession(target.id);
      acpChatSessionActions.deleteSnapshot(target.id);
      setDeleteTarget(null);
      window.dispatchEvent(new CustomEvent(AppEvents.SESSION_DELETED, { detail: { sessionId: target.id } }));
      toast.success(intl.formatMessage(i18n.deleted));
    } catch (error) {
      toast.error(intl.formatMessage(i18n.deleteFailed, { name: target.name, error: errorMessage(error) }));
    } finally {
      deleting.current = false;
      setIsDeleting(false);
    }
  };

  const handleExport = async () => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const destination = await window.electron.showSaveDialog({
        title: intl.formatMessage(i18n.export),
        defaultDirectory: 'desktop',
        defaultPath: `session-${session.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (destination.canceled || !destination.filePath) return;
      const json = await acpExportSession(session.id);
      if (!(await window.electron.writeFile(destination.filePath, json)))
        throw new Error(intl.formatMessage(i18n.exportLogWriteFailed));
      toast.success(intl.formatMessage(i18n.exported));
    } catch (error) {
      toast.error(intl.formatMessage(i18n.exportFailed, { error: errorMessage(error) }));
    } finally {
      setIsExporting(false);
    }
  };

  const handleViewJson = useCallback(async () => {
    if (!session) return;

    const loadRequestId = ++jsonLoadRequestId.current;
    setIsJsonOpen(true);
    setJsonValue(null);
    setJsonText('');
    setIsJsonLoading(true);
    try {
      const json = await acpExportSession(session.id);
      const parsed = parseSessionJson(json);
      if (jsonLoadRequestId.current !== loadRequestId) return;
      setJsonValue(parsed.value);
      setJsonText(parsed.pretty);
    } catch (error) {
      if (jsonLoadRequestId.current !== loadRequestId) return;
      setIsJsonOpen(false);
      toast.error(
        intl.formatMessage(i18n.jsonFailed, {
          error: errorMessage(error, 'Unknown error'),
        })
      );
    } finally {
      if (jsonLoadRequestId.current === loadRequestId) {
        setIsJsonLoading(false);
      }
    }
  }, [intl, session]);

  const handleExportLog = useCallback(async () => {
    if (!session || exportingLog.current) return;
    exportingLog.current = true;
    setIsExportingLog(true);
    try {
      const destination = await window.electron.showSaveDialog({
        title: intl.formatMessage(i18n.exportLog),
        message: intl.formatMessage(i18n.exportLogNotice),
        defaultDirectory: 'desktop',
        defaultPath: 'codebuddy-diagnostics.jsonl',
        filters: [{ name: 'JSONL', extensions: ['jsonl'] }],
      });
      if (destination.canceled || !destination.filePath) return;
      const data = await acpExportSessionLog(session.id);
      if (!(await window.electron.writeFile(destination.filePath, data))) {
        throw new Error(intl.formatMessage(i18n.exportLogWriteFailed));
      }
      toast.success(intl.formatMessage(i18n.exportLogSaved));
    } catch {
      toast.error(intl.formatMessage(i18n.exportLogFailed));
    } finally {
      exportingLog.current = false;
      setIsExportingLog(false);
    }
  }, [intl, session]);

  const handleCopyJson = useCallback(async () => {
    if (!jsonText) return;
    await navigator.clipboard.writeText(jsonText);
    toast.success(intl.formatMessage(i18n.copiedJson));
  }, [intl, jsonText]);

  const handleCopyFullText = useCallback(async () => {
    if (!fullTextSelection) return;
    await navigator.clipboard.writeText(fullTextSelection.value);
    toast.success(intl.formatMessage(i18n.copiedText));
  }, [fullTextSelection, intl]);

  const handleJsonOpenChange = useCallback((open: boolean) => {
    setIsJsonOpen(open);
    if (!open) {
      jsonLoadRequestId.current += 1;
      setIsJsonLoading(false);
      setFullTextSelection(null);
    }
  }, []);

  const handleRenameKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        void handleRename();
      }
    },
    [handleRename]
  );

  if (!session) {
    return null;
  }

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <div
            onPointerDown={(event) => event.preventDefault()}
            onClick={(event) => {
              if ((event.target as HTMLElement).closest('[data-session-menu-trigger]')) {
                event.stopPropagation();
                setMenuOpen(true);
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenuOpen(true);
            }}
          >
            {children}
          </div>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuItem
            onSelect={() => {
              try {
                setSessionPinned(session.id, !pinned);
              } catch (error) {
                toast.error(intl.formatMessage(i18n.pinFailed, { error: errorMessage(error) }));
              }
            }}
          >
            {pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
            {intl.formatMessage(pinned ? i18n.unpin : i18n.pin)}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setIsRenameOpen(true)}>
            <Edit2 className="size-4" />
            {intl.formatMessage(i18n.renameSession)}
          </DropdownMenuItem>
          {session.workingDir && (
            <DropdownMenuItem onSelect={() => void handleOpenFolder()}>
              <FolderOpen className="size-4" />
              {intl.formatMessage(i18n.openFolder)}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem disabled={isArchiving} onSelect={() => void handleArchive()}>
            <Archive className="size-4" />
            {intl.formatMessage(i18n.archive)}
          </DropdownMenuItem>
          <DropdownMenuItem className="text-red-600" disabled={isDeleting || isArchiving} onSelect={() => setDeleteTarget(session)}>
            <Trash2 className="size-4" />
            {intl.formatMessage(i18n.delete)}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void handleCopySessionId()}>
            <Copy className="size-4" />
            {intl.formatMessage(i18n.copySessionId)}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={isExporting} onSelect={() => void handleExport()}>
            <Download className="size-4" />
            {intl.formatMessage(i18n.export)}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={isDuplicating || !canForkSession(session.sessionType)}
            title={
              !canForkSession(session.sessionType)
                ? intl.formatMessage(sessionCapabilityMessages.forkUnavailable)
                : intl.formatMessage(i18n.branchHint)
            }
            onSelect={() => void handleDuplicate()}
          >
            {isDuplicating ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <GitBranch className="size-4" />
            )}
            {intl.formatMessage(i18n.duplicateSession)}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void handleViewJson()}>
            {isJsonLoading ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <FileJson className="size-4" />
            )}
            {intl.formatMessage(i18n.viewJson)}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={isExportingLog} onSelect={() => void handleExportLog()}>
            {isExportingLog ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            {intl.formatMessage(i18n.exportLog)}
          </DropdownMenuItem>
          <div className="px-2 py-1.5 text-xs whitespace-normal text-text-secondary" data-testid="diagnostic-export-notice">
            {intl.formatMessage(i18n.exportLogNotice)}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmationModal
        isOpen={!!deleteTarget}
        title={intl.formatMessage(i18n.deleteTitle)}
        message={intl.formatMessage(i18n.deleteMessage, { name: deleteTarget?.name ?? '' })}
        confirmLabel={intl.formatMessage(i18n.delete)}
        cancelLabel={intl.formatMessage(i18n.cancelDelete)}
        confirmVariant="destructive"
        isSubmitting={isDeleting}
        onCancel={() => { if (!deleting.current) setDeleteTarget(null); }}
        onConfirm={() => void handleDelete()}
      />

      <Dialog open={isRenameOpen} onOpenChange={setIsRenameOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{intl.formatMessage(i18n.renameTitle)}</DialogTitle>
          </DialogHeader>
          <input
            type="text"
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={handleRenameKeyDown}
            placeholder={intl.formatMessage(i18n.renamePlaceholder)}
            className="w-full rounded-lg border border-border-primary bg-background-primary p-3 text-text-primary outline-none focus:ring-2 focus:ring-border-active"
            disabled={isRenaming}
            maxLength={200}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsRenameOpen(false)} disabled={isRenaming}>
              {intl.formatMessage(i18n.cancel)}
            </Button>
            <Button
              onClick={() => void handleRename()}
              disabled={isRenaming || !renameValue.trim()}
            >
              {isRenaming ? intl.formatMessage(i18n.saving) : intl.formatMessage(i18n.save)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isJsonOpen} onOpenChange={handleJsonOpenChange}>
        <DialogContent className="grid max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{intl.formatMessage(i18n.jsonTitle)}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 overflow-hidden rounded-lg border border-border-primary bg-background-secondary">
            {isJsonLoading ? (
              <div className="flex h-64 items-center justify-center gap-2 text-sm text-text-secondary">
                <LoaderCircle className="size-4 animate-spin" />
                {intl.formatMessage(i18n.loadingJson)}
              </div>
            ) : (
              <div className="max-h-[60vh] overflow-auto p-3">
                <JsonTree value={jsonValue} onOpenText={setFullTextSelection} />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsJsonOpen(false)}>
              {intl.formatMessage(i18n.close)}
            </Button>
            <Button onClick={() => void handleCopyJson()} disabled={!jsonText || isJsonLoading}>
              {intl.formatMessage(i18n.copyJson)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!fullTextSelection}
        onOpenChange={(open) => !open && setFullTextSelection(null)}
      >
        <DialogContent className="grid max-h-[80vh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{intl.formatMessage(i18n.fullTextTitle)}</DialogTitle>
          </DialogHeader>
          {fullTextSelection && (
            <div className="min-h-0 space-y-3">
              <code className="block truncate rounded-md bg-background-secondary px-3 py-2 text-xs text-text-secondary">
                {fullTextSelection.path}
              </code>
              <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border-primary bg-background-secondary p-4 text-xs leading-5 text-text-primary">
                {fullTextSelection.value}
              </pre>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setFullTextSelection(null)}>
              {intl.formatMessage(i18n.close)}
            </Button>
            <Button onClick={() => void handleCopyFullText()} disabled={!fullTextSelection}>
              {intl.formatMessage(i18n.copyText)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default SessionActionsContextMenu;
