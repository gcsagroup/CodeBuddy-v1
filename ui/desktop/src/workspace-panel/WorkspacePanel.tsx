import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useSearchParams } from 'react-router-dom';
import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  Globe,
  Home,
  Maximize2,
  Minimize2,
  PanelLeft,
  WrapText,
  FileCode2,
  FileDiff,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Save,
  Search,
  TerminalSquare,
  Bot,
  X,
} from 'lucide-react';
import { useIntl } from '../i18n';
import { AppEvents } from '../constants/events';
import { cn } from '../utils';
import { formatShortcut } from '../utils/keyboardShortcuts';
import { useAcpChatSessionSnapshot } from '../acp/chatSessionStore';
import MarkdownContent from '../components/MarkdownContent';
import { WorkspaceMedia } from './WorkspaceMedia';
import { SubagentAvatar } from '../components/SubagentAvatar';
import { ConfirmationModal } from '../components/ui/ConfirmationModal';
import { WorkspaceBrowser } from './WorkspaceBrowser';
import { WorkspaceTerminal } from './WorkspaceTerminal';
import { WorkspaceSubagent } from './WorkspaceSubagent';
import {
  WorkspaceSubagents,
  SubagentCatalogProvider,
  subagentsMessages,
} from './WorkspaceSubagents';
import { ChatState } from '../types/chatState';
import { WorkspaceChanges, changeMessages } from './WorkspaceChanges';
import { OPEN_CONVERSATION_CHANGE, type ConversationChangeTarget } from './conversationChangePanel';
import { OPEN_WORKSPACE_FILE, type WorkspaceFileTarget } from './workspaceFilePanel';
import {
  collectConversationChanges,
  fileIdentity,
  conversationFileOperation,
} from '../components/codepro/conversationChanges';
import type { Message } from '../types/message';
import {
  OPEN_SUBAGENT_CATALOG,
  OPEN_SUBAGENT_CONVERSATION,
  type SubagentConversationTarget,
} from './subagentPanel';
import { panelMessages as m } from './workspacePanelMessages';
import type { PanelEntry, PanelScope } from './workspacePanelTypes';
import {
  hasUnsavedWorkbenchFiles,
  readWorkbench,
  saveWorkbench,
  scopeKey,
  type WorkbenchState,
  type WorkbenchTab,
} from './workspacePanelStore';
import { WorkspaceCodePreview } from './WorkspaceCodePreview';
import { WorkspaceGeneration, useMediaJobs, mediaText } from './WorkspaceGeneration';
import './workspacePanel.css';
const openedMediaJobs = new Set<string>();

export const WORKSPACE_PANEL_GAP = 0;
export const WORKSPACE_PANEL_TRANSITION = {
  duration: 0.22,
  ease: [0.22, 1, 0.36, 1] as const,
};
export type WorkspacePanelLayout = 'inline' | 'overlay' | 'drawer';
type Props = {
  expanded: boolean;
  layout?: WorkspacePanelLayout;
  onExpandedChange: (open: boolean) => void;
  width: number;
  resizing?: boolean;
  onWidthChange?: (width: number, commit?: boolean) => void;
  chatCollapsed?: boolean;
  onChatCollapsedChange?: (collapsed: boolean) => void;
  onResetWidth?: () => void;
};
const EMPTY_MESSAGES: Message[] = [];
export function WorkspacePanel(props: Props) {
  const [params] = useSearchParams();
  const id = params.get('resumeSessionId') ?? '';
  const snapshot = useAcpChatSessionSnapshot(id);
  const binding = snapshot?.session?.extension_data.workspaceBinding;
  const isContainer =
    snapshot?.session?.extension_data.readonlyHistory === true ||
    binding === 'project_container' ||
    binding === 'root_container' ||
    binding === 'unbound';
  const scope = useMemo(
    () => ({
      sessionId: id,
      root: isContainer ? '' : (snapshot?.session?.working_dir ?? ''),
    }),
    [id, snapshot?.session?.working_dir, isContainer]
  );
  return (
    <SubagentCatalogProvider
      key={scopeKey(scope)}
      parentSessionId={id}
      enabled={
        !!snapshot?.session && !!scope.root && snapshot.chatState !== ChatState.LoadingConversation
      }
      active={
        props.expanded ||
        (!!snapshot &&
          ![ChatState.Idle, ChatState.LoadingConversation].includes(snapshot.chatState))
      }
    >
      <WorkspacePanelContent
        {...props}
        scope={scope}
        messages={snapshot?.messages ?? EMPTY_MESSAGES}
      />
    </SubagentCatalogProvider>
  );
}

function FileTree({
  scope,
  directory = '',
  depth = 0,
  refresh,
  onOpen,
  onError,
  activePath,
}: {
  scope: PanelScope;
  activePath?: string;
  directory?: string;
  depth?: number;
  refresh: number;
  onOpen: (e: PanelEntry) => void;
  onError: (e: unknown) => void;
}) {
  const [entries, setEntries] = useState<PanelEntry[]>([]),
    [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    void window.electron
      .workspacePanel({ scope, action: 'list', path: directory })
      .then((r) => {
        if (alive) setEntries(r.entries ?? []);
      })
      .catch((e) => {
        if (alive) onError(e);
      });
    return () => {
      alive = false;
    };
  }, [scope, directory, refresh, onError]);
  return (
    <ul>
      {entries.map((e) => (
        <li key={e.path}>
          <button
            className={`wb-tree-entry ${activePath === e.path ? 'is-active' : ''}`}
            aria-current={activePath === e.path ? 'page' : undefined}
            style={{ paddingLeft: depth * 12 + 8 }}
            title={e.path}
            disabled={e.kind === 'link'}
            onClick={() =>
              e.kind === 'directory'
                ? setExpanded((old) => {
                    const next = new Set(old);
                    if (next.has(e.path)) next.delete(e.path);
                    else next.add(e.path);
                    return next;
                  })
                : onOpen(e)
            }
          >
            {e.kind === 'directory' ? (
              <>
                {expanded.has(e.path) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <Folder size={14} className="text-amber-500 shrink-0" />
              </>
            ) : (
              <File size={14} className="ml-3 shrink-0 text-text-secondary" />
            )}
            <span className="truncate">{e.name}</span>
          </button>
          {e.kind === 'directory' && expanded.has(e.path) && (
            <FileTree
              {...{ scope, refresh, onOpen, onError, activePath }}
              directory={e.path}
              depth={depth + 1}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

export function WorkspacePanelContent({
  scope,
  expanded,
  onExpandedChange,
  width,
  resizing = false,
  onWidthChange,
  chatCollapsed = false,
  onChatCollapsedChange,
  onResetWidth,
  messages = EMPTY_MESSAGES,
}: Props & { scope: PanelScope; messages?: Message[] }) {
  const intl = useIntl(),
    key = scopeKey(scope);
  const reducedMotion = useReducedMotion();
  const [contentMounted, setContentMounted] = useState(expanded);
  useEffect(() => {
    if (expanded) setContentMounted(true);
  }, [expanded]);
  const [state, setState] = useState(() => {
    const saved = readWorkbench(key);
    return saved.active === 'git' ? { ...saved, active: 'start' } : saved;
  });
  const [confirmation, setConfirmation] = useState<{
    message: string;
    resolve: (value: boolean) => void;
  }>();
  const pendingConfirmation = useRef<((value: boolean) => void) | undefined>(undefined);
  const confirm = (message: string) =>
    new Promise<boolean>((resolve) => {
      pendingConfirmation.current?.(false);
      pendingConfirmation.current = resolve;
      setConfirmation({ message, resolve });
    });
  const resolveConfirmation = (value: boolean) => {
    pendingConfirmation.current?.(value);
    pendingConfirmation.current = undefined;
    setConfirmation(undefined);
  };
  useEffect(() => () => pendingConfirmation.current?.(false), []);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const resizeCleanup = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => resizeCleanup.current?.(), []);
  const [treeOpen, setTreeOpen] = useState(false);
  const [conversationRevision, setConversationRevision] = useState(0);
  const [wrap, setWrap] = useState(false);
  const tabStrip = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState(''),
    [results, setResults] = useState<PanelEntry[]>([]),
    [truncated, setTruncated] = useState(false),
    [refresh, setRefresh] = useState(0);
  const alive = useRef(true),
    search = useRef<HTMLInputElement>(null),
    latest = useRef(state);
  const fail = useCallback((e: unknown) => {
    if (alive.current) setError(String(e));
  }, []);
  const update = useCallback(
    (apply: (s: WorkbenchState) => WorkbenchState) => {
      const next = apply(latest.current);
      latest.current = next;
      saveWorkbench(key, next);
      if (alive.current) setState(next);
    },
    [key]
  );
  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ sessionId: string }>).detail?.sessionId !== scope.sessionId)
        return;
      // These native child addresses belong to the retired conversation.
      // Keep file tabs and unsaved drafts in the unchanged workspace.
      update((current) => ({
        tabs: current.tabs.filter((tab) => tab.kind !== 'subagent'),
        active: current.tabs.some((tab) => tab.id === current.active && tab.kind === 'subagent')
          ? 'subagents'
          : current.active,
      }));
      setConversationRevision((value) => value + 1);
    };
    window.addEventListener(AppEvents.SESSION_CONVERSATION_CHANGED, changed);
    return () => window.removeEventListener(AppEvents.SESSION_CONVERSATION_CHANGED, changed);
  }, [scope.sessionId, update]);
  const { jobs: mediaJobs, disconnected: mediaDisconnected } = useMediaJobs(scope.sessionId);
  useEffect(() => {
    const fresh = mediaJobs.find(
      (job) =>
        !openedMediaJobs.has(`${scope.sessionId}:${job.job_id}`) &&
        ['queued', 'running', 'preparing'].includes(job.status) &&
        Date.now() - Date.parse(job.created_at) < 300_000
    );
    if (!fresh) return;
    openedMediaJobs.add(`${scope.sessionId}:${fresh.job_id}`);
    update((current) => ({ ...current, active: 'media' }));
    onExpandedChange(true);
  }, [mediaJobs, scope.sessionId, update, onExpandedChange]);
  const selected = state.tabs.find((t) => t.id === state.active);
  useEffect(() => {
    tabStrip.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [state.active]);
  const available = !!scope.root && !!scope.sessionId;
  useEffect(() => {
    const open = (event: Event) => {
      const target = (event as CustomEvent<SubagentConversationTarget>).detail;
      if (!target || target.parentSessionId !== scope.sessionId || !target.childSessionId) return;
      const id = `subagent:${target.childSessionId}`;
      update((s) => ({
        tabs: s.tabs.some((tab) => tab.id === id)
          ? s.tabs
          : [...s.tabs, { id, kind: 'subagent', ...target }],
        active: id,
      }));
      onExpandedChange(true);
    };
    window.addEventListener(OPEN_SUBAGENT_CONVERSATION, open);
    const openCatalog = (event: Event) => {
      const target = (event as CustomEvent<{ parentSessionId: string }>).detail;
      if (target?.parentSessionId !== scope.sessionId) return;
      update((current) => ({ ...current, active: 'subagents' }));
      onExpandedChange(true);
    };
    window.addEventListener(OPEN_SUBAGENT_CATALOG, openCatalog);
    return () => {
      window.removeEventListener(OPEN_SUBAGENT_CONVERSATION, open);
      window.removeEventListener(OPEN_SUBAGENT_CATALOG, openCatalog);
    };
  }, [scope.sessionId, update, onExpandedChange]);
  const fileView =
    state.active === 'files' || selected?.kind === 'file' || selected?.kind === 'file-info';
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    // eslint-disable-next-line no-undef
    const check = (e: BeforeUnloadEvent) => {
      if (hasUnsavedWorkbenchFiles()) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', check);
    return () => window.removeEventListener('beforeunload', check);
  }, []);
  useEffect(() => {
    if (!query.trim() || !available) {
      setResults([]);
      setTruncated(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void window.electron
        .workspacePanel({ scope, action: 'search', query })
        .then((r) => {
          if (!cancelled) {
            setResults(r.entries ?? []);
            setTruncated(!!r.truncated);
          }
        })
        .catch((e) => {
          if (!cancelled) fail(e);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, scope, available, fail]);
  const activate = useCallback(
    (id: string) => {
      setError('');
      update((s) => ({ ...s, active: id }));
    },
    [update]
  );
  const openFile = useCallback(
    async (entry: PanelEntry) => {
      const existing = latest.current.tabs.find(
        (t) =>
          (t.kind === 'file' || t.kind === 'file-info') &&
          fileIdentity(t.kind === 'file' ? t.document.path : t.file.path, scope.root) ===
            fileIdentity(entry.path, scope.root)
      );
      if (existing) {
        activate(existing.id);
        return;
      }
      setBusy(true);
      setError('');
      try {
        if (/\.(docx|xlsx|pptx|pdf)$/i.test(entry.path)) {
          const reply = await window.electron.workspacePanel({
            scope,
            action: 'inspect',
            path: entry.path,
          });
          if (!alive.current) return;
          const file = reply?.file;
          if (!file) throw new Error(intl.formatMessage(m.restartDesktop));
          update((s) => {
            const existing = s.tabs.find(
              (t) =>
                t.kind === 'file-info' &&
                fileIdentity(t.file.path, scope.root) === fileIdentity(file.path, scope.root)
            );
            if (existing) return { ...s, active: existing.id };
            const id = globalThis.crypto.randomUUID();
            return {
              tabs: [...s.tabs, { id, kind: 'file-info', title: entry.name, file }],
              active: id,
            };
          });
          return;
        }
        const { document } = await window.electron.workspacePanel({
          scope,
          action: 'read',
          path: entry.path,
        });
        if (!document || !alive.current) return;
        update((s) => {
          const duplicate = s.tabs.find(
            (t) =>
              t.kind === 'file' &&
              fileIdentity(t.document.path, scope.root) === fileIdentity(entry.path, scope.root)
          );
          if (duplicate) return { ...s, active: duplicate.id };
          const id = globalThis.crypto.randomUUID();
          return {
            tabs: [
              ...s.tabs,
              {
                id,
                kind: 'file',
                title: entry.name,
                document,
                draft: document.content,
                preview: true,
              },
            ],
            active: id,
          };
        });
      } catch (e) {
        fail(e);
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [scope, activate, update, fail, intl]
  );
  useEffect(() => {
    const open = (event: Event) => {
      const target = (event as CustomEvent<WorkspaceFileTarget>).detail;
      if (!target || target.sessionId !== scope.sessionId || !target.filePath) return;
      onExpandedChange(true);
      if (!available) {
        setError(intl.formatMessage(m.noWorkspace));
        return;
      }
      void openFile({
        kind: 'file',
        path: target.filePath,
        name: target.filePath.replace(/\\/g, '/').split('/').pop() || target.filePath,
      });
    };
    window.addEventListener(OPEN_WORKSPACE_FILE, open);
    return () => window.removeEventListener(OPEN_WORKSPACE_FILE, open);
  }, [scope.sessionId, available, openFile, onExpandedChange, intl]);
  useEffect(() => {
    const open = (event: Event) => {
      const target = (event as CustomEvent<ConversationChangeTarget>).detail;
      if (!target || target.sessionId !== scope.sessionId) return;
      const operation = target.toolCallId
        ? conversationFileOperation(messages, target.toolCallId)
        : undefined;
      if (
        target.toolCallId &&
        (!operation ||
          !target.filePath ||
          fileIdentity(operation.path, scope.root) !== fileIdentity(target.filePath, scope.root))
      ) {
        setError(intl.formatMessage(changeMessages.missing));
        onExpandedChange(true);
        return;
      }
      if (operation?.kind === 'read') {
        if (available)
          void openFile({
            kind: 'file',
            path: operation.path,
            name: operation.path.replace(/\\/g, '/').split('/').pop() || operation.path,
          });
        else setError(intl.formatMessage(m.noWorkspace));
      } else if ((!target.turnId && !target.toolCallId) || !target.filePath) {
        update((current) => ({ ...current, active: 'changes' }));
      } else {
        const filePath = operation?.path ?? target.filePath;
        const turnId = target.turnId;
        const id = target.toolCallId
          ? `change-call:${JSON.stringify([target.toolCallId, fileIdentity(filePath, scope.root)])}`
          : `change:${JSON.stringify([turnId, fileIdentity(filePath, scope.root)])}`;
        const turn =
          turnId &&
          collectConversationChanges(messages, scope.root).find((item) => item.id === turnId);
        const name = filePath.replace(/\\/g, '/').split('/').pop() || filePath;
        const title = turn
          ? `${intl.formatMessage(turn.number ? changeMessages.turn : changeMessages.unassigned, { number: turn.number })} · ${name}`
          : name;
        update((current) => ({
          tabs: current.tabs.some((tab) => tab.id === id)
            ? current.tabs
            : [
                ...current.tabs,
                {
                  id,
                  kind: 'change',
                  turnId,
                  filePath,
                  title,
                  ...(target.toolCallId ? { toolCallId: target.toolCallId } : {}),
                },
              ],
          active: id,
        }));
      }
      onExpandedChange(true);
    };
    window.addEventListener(OPEN_CONVERSATION_CHANGE, open);
    return () => window.removeEventListener(OPEN_CONVERSATION_CHANGE, open);
  }, [scope.sessionId, scope.root, messages, intl, update, onExpandedChange, available, openFile]);
  const add = useCallback(
    async (kind: 'terminal' | 'browser') => {
      if (!available) return;
      onExpandedChange(true);
      setBusy(true);
      setError('');
      try {
        const { id } = await window.electron.workspacePanel({
          scope,
          action: kind === 'terminal' ? 'terminal-create' : 'browser-create',
        });
        if (id)
          update((s) => ({
            tabs: [
              ...s.tabs,
              {
                id,
                kind,
                title: `${intl.formatMessage(kind === 'terminal' ? m.terminal : m.browser)} ${s.tabs.filter((t) => t.kind === kind).length + 1}`,
              },
            ],
            active: id,
          }));
      } catch (e) {
        fail(e);
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [available, scope, onExpandedChange, intl, update, fail]
  );
  const save = useCallback(async () => {
    const tab = latest.current.tabs.find((t) => t.id === latest.current.active);
    if (
      tab?.kind !== 'file' ||
      tab.document.image ||
      tab.document.media ||
      tab.document.binary ||
      tab.draft === tab.document.content
    )
      return;
    setBusy(true);
    setError('');
    try {
      const { document } = await window.electron.workspacePanel({
        scope,
        action: 'save',
        path: tab.document.path,
        content: tab.draft,
        version: tab.document.version,
      });
      if (document)
        update((s) => ({
          ...s,
          tabs: s.tabs.map((t) => (t.id === tab.id && t.kind === 'file' ? { ...t, document } : t)),
        }));
    } catch (e) {
      fail(e);
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [scope, update, fail]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        !(e.ctrlKey || e.metaKey) ||
        e.isComposing ||
        e.shiftKey ||
        document.querySelector('[role="dialog"]')
      )
        return;
      if (!e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        onExpandedChange(true);
        activate('files');
        setTimeout(() => search.current?.focus(), 0);
      }
      // Option changes KeyboardEvent.key on macOS (for example B becomes ∫).
      if (e.altKey && (e.code === 'KeyB' || e.key.toLowerCase() === 'b')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void add('browser');
      }
      if (!e.altKey && e.code === 'Backquote') {
        e.preventDefault();
        void add('terminal');
      }
      if (
        !e.altKey &&
        e.key.toLowerCase() === 's' &&
        latest.current.tabs.find((t) => t.id === latest.current.active)?.kind === 'file'
      ) {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [activate, add, save, onExpandedChange]);
  const close = async (tab: WorkbenchTab) => {
    if (
      tab.kind === 'file' &&
      tab.draft !== tab.document.content &&
      !(await confirm(intl.formatMessage(m.discard)))
    )
      return;
    if (tab.kind === 'terminal' && !(await confirm(intl.formatMessage(m.closeTerminal)))) return;
    try {
      if (tab.kind === 'terminal' || tab.kind === 'browser')
        await window.electron.workspacePanel({
          scope,
          action: tab.kind === 'terminal' ? 'terminal-close' : 'browser-close',
          id: tab.id,
        });
      update((s) => ({
        tabs: s.tabs.filter((t) => t.id !== tab.id),
        active: s.active === tab.id ? 'start' : s.active,
      }));
    } catch (e) {
      fail(e);
    }
  };
  const reload = async (tab: Extract<WorkbenchTab, { kind: 'file' }>) => {
    if (tab.draft !== tab.document.content && !(await confirm(intl.formatMessage(m.discard))))
      return;
    try {
      const { document } = await window.electron.workspacePanel({
        scope,
        action: 'read',
        path: tab.document.path,
      });
      if (document) {
        update((s) => ({
          ...s,
          tabs: s.tabs.map((t) =>
            t.id === tab.id && t.kind === 'file' && t.draft === tab.draft
              ? { ...t, document, draft: document.content }
              : t
          ),
        }));
        setError('');
      }
    } catch (e) {
      fail(e);
    }
  };
  const panelContent = (
    <div className="workspace-panel flex h-full flex-col border-l border-border-primary bg-background-primary text-text-primary">
      <ConfirmationModal
        isOpen={!!confirmation}
        title={intl.formatMessage(m.panel)}
        message={confirmation?.message ?? ''}
        onConfirm={() => resolveConfirmation(true)}
        onCancel={() => resolveConfirmation(false)}
      />
      <div
        role="separator"
        aria-label={intl.formatMessage(m.resize)}
        aria-orientation="vertical"
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        className="no-drag group absolute left-0 top-0 bottom-0 z-30 w-1.5 cursor-col-resize touch-none outline-none"
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            if (chatCollapsed && e.key === 'ArrowRight') onChatCollapsedChange?.(false);
            else onWidthChange?.(width + (e.key === 'ArrowLeft' ? 32 : -32));
          } else if (e.key === 'Home') {
            e.preventDefault();
            onResetWidth?.();
          }
        }}
        onDoubleClick={onResetWidth}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          resizeCleanup.current?.();
          const start = e.clientX;
          const target = e.currentTarget;
          target.setPointerCapture(e.pointerId);
          let requested = width;
          // eslint-disable-next-line no-undef
          const move = (event: PointerEvent) => {
            requested = width + start - event.clientX;
            onWidthChange?.(requested, false);
          };
          const cleanup = () => {
            target.removeEventListener('pointermove', move);
            target.removeEventListener('pointerup', stop);
            target.removeEventListener('pointercancel', stop);
            target.removeEventListener('lostpointercapture', stop);
            resizeCleanup.current = undefined;
          };
          // eslint-disable-next-line no-undef
          const stop = (event: PointerEvent) => {
            cleanup();
            onWidthChange?.(event.type === 'pointerup' ? requested : width);
          };
          resizeCleanup.current = cleanup;
          target.addEventListener('pointermove', move);
          target.addEventListener('pointerup', stop);
          target.addEventListener('pointercancel', stop);
          target.addEventListener('lostpointercapture', stop);
        }}
      >
        <span
          aria-hidden="true"
          className={cn(
            'absolute inset-y-0 left-0 w-px bg-transparent transition-colors group-hover:bg-blue-500 group-focus-visible:bg-blue-500',
            resizing && 'bg-blue-500'
          )}
        />
      </div>
      <header className="wb-header">
        <button
          className="wb-icon"
          title={intl.formatMessage(m.start)}
          onClick={() => activate('start')}
        >
          <Home size={16} />
        </button>
        <div
          ref={tabStrip}
          className="wb-tabs"
          role="tablist"
          aria-label={intl.formatMessage(m.panel)}
        >
          {state.active === 'start' && (
            <span className="wb-fixed-tab-label px-2 text-xs text-text-secondary">
              {intl.formatMessage(m.start)}
            </span>
          )}
          <button
            role="tab"
            aria-selected={state.active === 'files'}
            className="wb-tab"
            onClick={() => activate('files')}
            title={intl.formatMessage(m.files)}
          >
            <Folder size={14} />
          </button>
          <button
            role="tab"
            aria-selected={state.active === 'changes'}
            aria-label={intl.formatMessage(changeMessages.title)}
            className="wb-tab"
            onClick={() => activate('changes')}
            disabled={!scope.sessionId}
            title={intl.formatMessage(changeMessages.title)}
          >
            <FileDiff size={14} />
            <span className="wb-fixed-tab-label text-xs">
              {intl.formatMessage(changeMessages.title)}
            </span>
          </button>
          <button
            role="tab"
            aria-selected={state.active === 'subagents'}
            aria-label={intl.formatMessage(subagentsMessages.title)}
            className="wb-tab"
            onClick={() => activate('subagents')}
            disabled={!scope.sessionId}
            title={intl.formatMessage(subagentsMessages.title)}
          >
            <Bot size={14} />
            <span className="wb-fixed-tab-label text-xs">
              {intl.formatMessage(subagentsMessages.title)}
            </span>
          </button>
          {mediaJobs.length > 0 && (
            <button
              role="tab"
              aria-selected={state.active === 'media'}
              className="wb-tab"
              onClick={() => activate('media')}
            >
              {mediaText('Generation', '生成预览', '生成預覽')}
            </button>
          )}
          {state.tabs.map((t) => (
            <div key={t.id} className={`wb-tab ${t.id === state.active ? 'is-active' : ''}`}>
              <button
                role="tab"
                aria-selected={t.id === state.active}
                className="wb-tab-label"
                title={t.kind === 'file' ? t.document.path : t.title}
                onClick={() => activate(t.id)}
              >
                {t.kind === 'change' ? (
                  <FileDiff size={13} />
                ) : t.kind === 'file' || t.kind === 'file-info' ? (
                  <FileCode2 size={13} />
                ) : t.kind === 'terminal' ? (
                  <TerminalSquare size={13} />
                ) : t.kind === 'subagent' ? (
                  <SubagentAvatar sessionId={t.childSessionId} small />
                ) : (
                  <Globe size={13} />
                )}
                <span className="truncate">{t.title}</span>
                {t.kind === 'file' && t.draft !== t.document.content ? ' ●' : ''}
              </button>
              <button
                className="wb-tab-close"
                aria-label={`${intl.formatMessage(m.close)} ${t.title}`}
                onClick={() => void close(t)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
        <button
          className="wb-icon"
          title={intl.formatMessage(m.start)}
          onClick={() => activate('start')}
        >
          <Plus size={16} />
        </button>
        <button
          className="wb-icon"
          title={intl.formatMessage(m.maximize)}
          onClick={() => onChatCollapsedChange?.(!chatCollapsed)}
        >
          {chatCollapsed ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
        <button
          className="wb-icon"
          title={intl.formatMessage(m.closePanel)}
          onClick={() => onExpandedChange(false)}
        >
          <PanelRightClose size={17} />
        </button>
      </header>
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 border-b border-red-200 bg-red-50 p-2 text-xs text-red-700"
        >
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button onClick={() => setError('')}>
            <X size={14} />
          </button>
        </div>
      )}
      {state.active === 'subagents' ? (
        <WorkspaceSubagents key={conversationRevision} parentSessionId={scope.sessionId} />
      ) : state.active === 'media' ? (
        <WorkspaceGeneration scope={scope} jobs={mediaJobs} disconnected={mediaDisconnected} />
      ) : state.active === 'changes' || selected?.kind === 'change' ? (
        <WorkspaceChanges
          sessionId={scope.sessionId}
          workspaceRoot={scope.root}
          messages={messages}
          selection={selected?.kind === 'change' ? selected : undefined}
        />
      ) : (!available && selected?.kind !== 'subagent') || state.active === 'start' ? (
        <div className="wb-start">
          <div className="mb-6 rounded-full border-2 border-border-primary p-3 text-text-secondary opacity-40">
            <Globe size={28} />
          </div>
          {[
            {
              label: m.files,
              sub: m.filesHint,
              shortcut: formatShortcut('CommandOrControl+P'),
              icon: <FolderOpen size={20} className="text-amber-500" />,
              click: () => activate('files'),
            },
            {
              label: m.terminal,
              sub: m.terminalHint,
              shortcut: formatShortcut('CommandOrControl+`'),
              icon: <TerminalSquare size={20} className="text-blue-500" />,
              click: () => void add('terminal'),
            },
            {
              label: m.browser,
              sub: m.browserHint,
              shortcut: formatShortcut('CommandOrControl+Alt+B'),
              icon: <Globe size={20} className="text-blue-500" />,
              click: () => void add('browser'),
            },
          ].map((card) => (
            <button
              key={card.label.id}
              disabled={busy || !available}
              className="wb-start-card"
              onClick={card.click}
            >
              {card.icon}
              <span className="flex-1">
                <span className="block text-sm">{intl.formatMessage(card.label)}</span>
                <span className="mt-1 block text-xs text-text-secondary">
                  {intl.formatMessage(card.sub)}
                </span>
              </span>
              <kbd className="text-[10px] text-text-secondary">{card.shortcut}</kbd>
            </button>
          ))}
          <p
            className="mt-4 max-w-full truncate text-[11px] text-text-secondary"
            title={scope.root}
          >
            {available ? scope.root : intl.formatMessage(m.noWorkspace)}
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {fileView && (state.active === 'files' || treeOpen) && (
            <section
              aria-label={intl.formatMessage(m.fileTree)}
              className={`wb-explorer ${selected?.kind === 'file' ? '' : 'wb-explorer-wide'}`}
            >
              <div className="wb-tree-search">
                <Search size={14} />
                <input
                  ref={search}
                  aria-label={intl.formatMessage(m.search)}
                  placeholder={intl.formatMessage(m.search)}
                  className="min-w-0 flex-1 bg-transparent text-xs outline-none"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <button
                  className="wb-icon"
                  title={intl.formatMessage(m.refresh)}
                  onClick={() => setRefresh((v) => v + 1)}
                >
                  <RefreshCw size={13} />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {query.trim() ? (
                  <>
                    <ul>
                      {results.map((e) => (
                        <li key={e.path}>
                          <button
                            disabled={e.kind !== 'file'}
                            className="w-full truncate px-2 py-1 text-left text-xs hover:bg-background-secondary"
                            title={e.path}
                            onClick={() => void openFile(e)}
                          >
                            {e.path}
                          </button>
                        </li>
                      ))}
                    </ul>
                    {truncated && (
                      <p className="p-2 text-xs">{intl.formatMessage(m.searchLimit)}</p>
                    )}
                  </>
                ) : (
                  <FileTree
                    {...{ scope, refresh, onError: fail }}
                    activePath={selected?.kind === 'file' ? selected.document.path : undefined}
                    onOpen={(e) => void openFile(e)}
                  />
                )}
              </div>
            </section>
          )}
          {selected?.kind === 'file-info' ? (
            <section className="min-w-0 flex-1 overflow-auto p-4">
              <div className="flex items-center gap-2">
                <File size={20} />
                <strong className="break-all">{selected.title}</strong>
              </div>
              <p className="mt-3 break-all text-sm text-text-secondary">{selected.file.path}</p>
              <p className="mt-2 text-sm text-text-secondary">
                {intl.formatNumber(selected.file.size)} B
              </p>
              <p className="mt-4 text-sm text-text-secondary">
                {intl.formatMessage(m.documentInfo)}
              </p>
              {selected.file.openExternally && (
                <button
                  type="button"
                  disabled={busy}
                  className="mt-3 rounded-lg border border-border-primary px-3 py-2 text-sm hover:bg-background-secondary"
                  onClick={() => {
                    setBusy(true);
                    setError('');
                    void window.electron
                      .workspacePanel({ scope, action: 'open-external', path: selected.file.path })
                      .catch(fail)
                      .finally(() => {
                        if (alive.current) setBusy(false);
                      });
                  }}
                >
                  {intl.formatMessage(m.openDocument)}
                </button>
              )}
            </section>
          ) : selected?.kind === 'file' ? (
            <section className="flex min-w-0 flex-1 flex-col">
              <div className="wb-toolbar">
                <button
                  className="wb-icon"
                  title={intl.formatMessage(m.fileTree)}
                  aria-label={intl.formatMessage(m.fileTree)}
                  aria-pressed={treeOpen}
                  onClick={() => setTreeOpen((value) => !value)}
                >
                  <PanelLeft size={15} />
                </button>
                <span className="min-w-0 flex-1 truncate" title={selected.document.path}>
                  {scope.root.replace(/[\\/]$/, '')}/{selected.document.path}
                </span>
                <button
                  className="wb-icon"
                  title={intl.formatMessage(m.reload)}
                  onClick={() => void reload(selected)}
                >
                  <RefreshCw size={14} />
                </button>
                {!selected.document.image &&
                  !selected.document.media &&
                  !selected.document.binary && (
                    <>
                      <button
                        className="wb-icon"
                        title={intl.formatMessage(m.wrap)}
                        aria-label={intl.formatMessage(m.wrap)}
                        aria-pressed={wrap}
                        onClick={() => setWrap((value) => !value)}
                      >
                        <WrapText size={15} />
                      </button>
                      <button
                        className="px-2 py-1 rounded hover:bg-background-secondary"
                        onClick={() =>
                          update((s) => ({
                            ...s,
                            tabs: s.tabs.map((t) =>
                              t.id === selected.id && t.kind === 'file'
                                ? { ...t, preview: !t.preview }
                                : t
                            ),
                          }))
                        }
                      >
                        {intl.formatMessage(selected.preview ? m.edit : m.preview)}
                      </button>
                      <button
                        className="wb-icon"
                        title={intl.formatMessage(m.save, {
                          shortcut: formatShortcut('CommandOrControl+S'),
                        })}
                        aria-label={intl.formatMessage(m.save, {
                          shortcut: formatShortcut('CommandOrControl+S'),
                        })}
                        disabled={busy || selected.draft === selected.document.content}
                        onClick={() => void save()}
                      >
                        <Save size={15} />
                      </button>
                    </>
                  )}
              </div>
              {selected.document.binary ? (
                <div role="status" className="p-4 text-sm text-text-secondary">
                  {intl.formatMessage(m.binaryFile, { name: selected.title })}
                </div>
              ) : selected.document.media ? (
                <div className="wb-media-preview">
                  <WorkspaceMedia media={selected.document.media} title={selected.title} />
                </div>
              ) : selected.document.image ? (
                <div className="overflow-auto p-4">
                  <img src={selected.document.image} alt={selected.title} />
                </div>
              ) : selected.preview ? (
                <div className="wb-file-preview">
                  {/\.mdx?$/i.test(selected.document.path) ? (
                    <MarkdownContent content={selected.draft} />
                  ) : (
                    <WorkspaceCodePreview
                      path={selected.document.path}
                      content={selected.draft}
                      wrap={wrap}
                    />
                  )}
                </div>
              ) : (
                <textarea
                  aria-label={intl.formatMessage(m.editor)}
                  spellCheck={false}
                  className="wb-editor"
                  wrap={wrap ? 'soft' : 'off'}
                  value={selected.draft}
                  onChange={(e) => {
                    const draft = e.target.value;
                    update((s) => ({
                      ...s,
                      tabs: s.tabs.map((t) =>
                        t.id === selected.id && t.kind === 'file' ? { ...t, draft } : t
                      ),
                    }));
                  }}
                />
              )}
              <footer className="wb-statusbar">
                <span>{intl.formatMessage(selected.preview ? m.preview : m.edit)}</span>
                <span>
                  {selected.draft !== selected.document.content
                    ? intl.formatMessage(m.unsaved)
                    : (selected.document.media?.mimeType ?? 'UTF-8')}
                </span>
              </footer>
            </section>
          ) : selected?.kind === 'subagent' ? (
            <WorkspaceSubagent
              key={selected.id}
              parentSessionId={selected.parentSessionId}
              childSessionId={selected.childSessionId}
              title={selected.title}
              ancestorSessionIds={selected.ancestorSessionIds}
            />
          ) : selected?.kind === 'terminal' ? (
            <WorkspaceTerminal key={selected.id} scope={scope} id={selected.id} />
          ) : selected?.kind === 'browser' ? (
            <WorkspaceBrowser key={selected.id} scope={scope} id={selected.id} />
          ) : (
            <p className="m-auto p-4 text-sm text-text-secondary">
              {intl.formatMessage(m.selectFile)}
            </p>
          )}
        </div>
      )}
    </div>
  );
  return (
    <>
      {!expanded && (
        <button
          className="absolute right-3 top-11 z-20 wb-icon bg-background-primary no-drag"
          aria-label={intl.formatMessage(m.open)}
          onClick={() => onExpandedChange(true)}
        >
          <PanelRightOpen size={18} />
        </button>
      )}
      <motion.aside
        aria-label={intl.formatMessage(m.panel)}
        aria-hidden={!expanded}
        inert={!expanded}
        className="absolute right-0 top-8 bottom-0 z-20 overflow-hidden"
        initial={false}
        animate={{ width: expanded ? width : 0 }}
        transition={{
          ...WORKSPACE_PANEL_TRANSITION,
          duration: resizing || reducedMotion ? 0 : WORKSPACE_PANEL_TRANSITION.duration,
        }}
        onAnimationComplete={() => {
          if (!expanded) setContentMounted(false);
        }}
      >
        {(expanded || contentMounted) && panelContent}
      </motion.aside>
    </>
  );
}
