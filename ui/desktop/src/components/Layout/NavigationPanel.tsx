import { ProjectEditor, projectEditorMessages } from './ProjectEditor';
import { MainConversationRow } from './MainConversationRow';
import { getAcpControlClient } from '../../acp/acpConnection';
import { AgentAvatar } from '../custom-agents/AgentAvatar';
import { useNativeSchedules } from '../../acp/nativeSchedules';
import { sessionHasPendingPermission, subscribeAcpPermissionRequests } from '../../acp/permissionRequests';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Archive, MoreHorizontal, Pin, MessagesSquare, Clock3, ChevronRight, Folder, FolderOpen, Pencil, MessageCirclePlus } from 'lucide-react';
import { toast } from 'react-toastify';
import { motion, useReducedMotion } from 'framer-motion';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';
import { useNavigationContext } from './NavigationContext';
import { useNavigationSessions } from '../../hooks/useNavigationSessions';
import {
  NAV_ITEMS,
  SETTINGS_NAV_ITEM,
  getNavItemLabel,
  type NavItem,
} from '../../hooks/useNavigationItems';
import { AppEvents } from '../../constants/events';
import { SessionIndicators } from '../SessionIndicators';
import type { PetSnapshot, PetTask } from '../../pets/petTypes';
import { acpArchiveSession, type SessionListItem } from '../../acp/sessions';
import { errorMessage } from '../../utils/conversionUtils';
import { cn } from '../../utils';
import type { ProjectGroup } from '../../utils/projectSessions';
import {
  getProjectAlias,
  saveProjectAlias,
} from '../../utils/projectAliases';
import { defineMessages, useIntl } from '../../i18n';
import type { WorkspaceMode } from '../../utils/navigationUtils';
import { withWorkspaceMode } from '../../utils/navigationUtils';
import { setSessionPinned, useSessionPins } from '../../utils/sessionPins';
import { setProjectPinned, useProjectPins } from '../../utils/projectPins';
import { getProjectLabel, projectPathIdentity } from '../../utils/projectSessions';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../ui/dialog';
import { acpListSessions } from '../../acp/sessions';
import { SessionActionsContextMenu } from '../SessionActionsHeader';
import { ConversationTitle } from '../ConversationTitle';
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/Tooltip';

type StreamState = 'idle' | 'loading' | 'streaming' | 'error';

interface SessionStatus {
  streamState: StreamState;
  hasUnreadActivity: boolean;
}

const i18n = defineMessages({
  workspaceChats: { id: 'navigationPanel.workspaceChats', defaultMessage: '{count, plural, one {# recent conversation} other {# recent conversations}} · {active} running' },
  newWorkspaceChat: { id: 'navigationPanel.newWorkspaceChat', defaultMessage: 'Choose a workspace and start a conversation' },
  newTaskChat: { id: 'navigationPanel.newTaskChat', defaultMessage: 'New task conversation' },
  sectionActions: { id: 'navigationPanel.sectionActions', defaultMessage: '{section} options' },
  collapseGroup: { id: 'navigationPanel.collapseGroup', defaultMessage: 'Collapse group' },
  expandGroup: { id: 'navigationPanel.expandGroup', defaultMessage: 'Expand group' },
  pinProject: { id: 'navigationPanel.pinProject', defaultMessage: 'Pin project' },
  unpinProject: { id: 'navigationPanel.unpinProject', defaultMessage: 'Unpin project' },
  pinned: { id: 'navigationPanel.pinned', defaultMessage: 'Pinned' },
  actions: { id: 'sessionActionsHeader.actionsLabel', defaultMessage: 'Session actions' },
  chats: {
    id: 'navigationPanel.chats',
    defaultMessage: 'Tasks',
  },
  noChats: {
    id: 'navigationPanel.noChats',
    defaultMessage: 'No recent tasks',
  },
  workspaces: { id: 'navigationPanel.workspaces', defaultMessage: 'Workspaces' },
  untitledSession: {
    id: 'navigationPanel.untitledSession',
    defaultMessage: 'Untitled session',
  },
});

const sidebarCardClass = 'w-80 max-w-[calc(100vw-24px)] max-h-[var(--radix-tooltip-content-available-height)] overflow-y-auto rounded-xl border border-border-primary bg-background-primary p-3 text-text-primary text-left text-wrap shadow-lg animate-none data-[state=closed]:animate-none';

function SidebarTooltip({ children, onOpen }: { children: React.ReactNode; onOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const dismiss = () => setOpen(false);
    window.addEventListener('blur', dismiss);
    return () => window.removeEventListener('blur', dismiss);
  }, [open]);
  return <Tooltip delayDuration={240} skipDelayDuration={0} disableHoverableContent open={open} onOpenChange={value => {
    setOpen(value);
    if (value) onOpen?.();
  }}>{children}</Tooltip>;
}

export const projectGroupLabelClassName =
  'min-h-7 rounded-[10px] px-2 text-sm font-medium text-text-primary transition-colors hover:bg-background-tertiary';

interface NavRowProps {
  item: NavItem;
  active: boolean;
  onClick: () => void;
}

const NavRow: React.FC<NavRowProps> = ({ item, active, onClick }) => {
  const intl = useIntl();
  const Icon = item.icon;
  return (
    <button onClick={onClick} className="app-nav-link no-drag w-full" aria-current={active ? 'page' : undefined}>
      <Icon className="size-4 shrink-0" />
      <span className="text-left flex-1 truncate">{getNavItemLabel(item, intl)}</span>
      {item.getTag && (
        <span className="text-xs font-mono text-text-secondary">{item.getTag()}</span>
      )}
    </button>
  );
};

interface SessionRowProps {
  nested?: boolean;
  hasSchedule?: boolean;
  session: SessionListItem;
  active: boolean;
  status: SessionStatus | undefined;
  onClick: () => void;
  onRenamed: () => void;
  onForked?: (id: string) => void;
}

export const SessionRow: React.FC<SessionRowProps> = ({
  nested = true,
  hasSchedule = false,
  session,
  active,
  status,
  onClick,
  onRenamed,
  onForked,
}) => {
  const intl = useIntl();
  const [isArchiving, setIsArchiving] = useState(false);
  const archiving = useRef(false);
  const pinned = useSessionPins().includes(session.id);
  const pendingPermission = React.useSyncExternalStore(
    subscribeAcpPermissionRequests, () => sessionHasPendingPermission(session.id)
  );
  // Older versions embedded the role avatar in the generated title itself.
  const role = session.agentProfile;
  const displayName = role && session.name === role.avatar + ' ' + role.name ? role.name : session.name;
  const isStreaming = status?.streamState === 'streaming';
  const hasError = status?.streamState === 'error';
  const hasUnread = status?.hasUnreadActivity ?? false;
  const archiveLabel = intl.formatMessage({
    id: 'sessions.action.archive',
    defaultMessage: 'Archive session',
  });
  const isBusy = isStreaming || status?.streamState === 'loading';
  const fullTitle = displayName || intl.formatMessage(i18n.untitledSession);
  const [cardOpenedAt, setCardOpenedAt] = useState(Date.now);
  const updated = [session.updatedAt, session.lastMessageAt, session.createdAt]
    .map(value => new Date(value ?? '')).find(date => Number.isFinite(date.getTime()));
  const elapsedSeconds = updated ? (updated.getTime() - cardOpenedAt) / 1000 : 0;
  const relativeUnit = Math.abs(elapsedSeconds) >= 86400 ? 'day' : Math.abs(elapsedSeconds) >= 3600 ? 'hour' : Math.abs(elapsedSeconds) >= 60 ? 'minute' : 'second';
  const relativeDivisor = relativeUnit === 'day' ? 86400 : relativeUnit === 'hour' ? 3600 : relativeUnit === 'minute' ? 60 : 1;
  const workspace = session.workingDir
    ? getProjectAlias(session.workingDir, getProjectLabel(session.workingDir))
    : intl.formatMessage({ id: 'navigationPanel.noWorkspace', defaultMessage: 'No workspace' });

  const handleArchive = async () => {
    if (archiving.current || isBusy) return;
    archiving.current = true;
    setIsArchiving(true);
    try {
      await acpArchiveSession(session.id);
      toast.success(intl.formatMessage({
        id: 'sessions.toast.archived', defaultMessage: 'Session archived',
      }));
    } catch (error) {
      toast.error(intl.formatMessage({
        id: 'sessions.toast.archiveFailed',
        defaultMessage: 'Failed to update session archive: {error}',
      }, { error: errorMessage(error) }));
    } finally {
      archiving.current = false;
      setIsArchiving(false);
    }
  };

  return (
    <SessionActionsContextMenu session={session} onSessionRenamed={onRenamed} onSessionForked={onForked}>
      <SidebarTooltip onOpen={() => setCardOpenedAt(Date.now())}>
        <TooltipTrigger asChild>
          <div
            data-session-row
            onKeyDown={event => {
              // Radix's surrounding menu trigger consumes Enter/Space. Let each
              // nested button receive its native keyboard activation instead.
              if ((event.key === 'Enter' || event.key === ' ') &&
                  (event.target as HTMLElement).closest('button')) event.stopPropagation();
            }}
            onClick={(event) => {
              if ((event.target as HTMLElement).closest('button')) return;
              onClick();
            }}
            className={cn(
              'group/session-row relative flex min-h-7 items-center gap-1.5 py-0.5 rounded-[10px] cursor-pointer text-sm font-normal',
              nested ? '-ml-3 mr-0 pl-6 pr-2' : 'ml-1 mr-0 min-h-8 px-3',
              !nested && hasSchedule && 'pl-7',
              'hover:text-text-primary transition-colors',
              active ? 'bg-background-tertiary' : 'hover:bg-background-tertiary'
            )}
          >
            {hasSchedule && (
              <Clock3
                aria-label={intl.formatMessage({
                  id: 'nativeSchedule.title',
                  defaultMessage: 'Automation tasks',
                })}
                className="absolute left-1 top-1/2 -translate-y-1/2 size-3.5 text-text-secondary"
              />
            )}

            <button type="button" onClick={onClick} aria-current={active ? 'page' : undefined}
              className="flex min-w-0 flex-1 items-center gap-1 rounded-sm text-left text-text-primary focus-visible:outline focus-visible:outline-2">
              <ConversationTitle>{fullTitle}</ConversationTitle>
              {pendingPermission && <span className="shrink-0 text-xs font-medium text-text-secondary">
                {intl.formatMessage({ id: 'navigationPanel.pendingPermission', defaultMessage: 'Awaiting approval' })}
              </span>}
            </button>

            <button
              type="button"
              aria-label={intl.formatMessage({ id: pinned ? 'sessionActions.unpin' : 'sessionActions.pin', defaultMessage: pinned ? 'Unpin session' : 'Pin session' })}
              aria-pressed={pinned}
              onClick={(event) => {
                event.stopPropagation();
                try { setSessionPinned(session.id, !pinned); }
                catch (error) { toast.error(errorMessage(error)); }
              }}
              className="hidden size-6 shrink-0 items-center justify-center rounded-md text-text-secondary group-hover/session-row:flex group-focus-within/session-row:flex hover:bg-background-secondary"
            >
              <Pin className={cn('size-3.5', pinned && 'fill-current')} />
            </button>
            <button
              type="button"
              aria-label={archiveLabel}
              title={archiveLabel}
              disabled={isBusy || isArchiving}
              aria-busy={isArchiving}
              onClick={(event) => {
                event.stopPropagation();
                void handleArchive();
              }}
              className="hidden size-6 shrink-0 items-center justify-center rounded-md text-text-secondary group-hover/session-row:flex group-focus-within/session-row:flex hover:bg-background-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-primary disabled:cursor-not-allowed disabled:opacity-30"
            >
              <Archive className="size-3.5" aria-hidden="true" />
            </button>
            <SessionIndicators isStreaming={isStreaming} hasUnread={hasUnread} hasError={hasError} />
          </div>
        </TooltipTrigger>
        <TooltipContent side="right" align="start" sideOffset={8} collisionPadding={12}
          arrowClassName="invisible pointer-events-none"
          className={sidebarCardClass}>
          <div className="text-sm font-medium leading-5 [overflow-wrap:anywhere]">{fullTitle}</div>
          <div className="mt-2 flex items-center gap-1.5 text-xs text-text-secondary">
            <Clock3 className="size-3.5 shrink-0" aria-hidden="true" />
            <span>{intl.formatMessage({ id: 'navigationPanel.updatedAt', defaultMessage: 'Updated' })}</span>
            {updated ? <time dateTime={updated.toISOString()}>
              <span className="block">{intl.formatRelativeTime(Math.round(elapsedSeconds / relativeDivisor), relativeUnit, { numeric: 'auto' })}</span>
              <span className="block mt-0.5">{intl.formatDate(updated, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            </time>
              : <span>{intl.formatMessage({ id: 'navigationPanel.unknownTime', defaultMessage: 'Time unavailable' })}</span>}
          </div>
          <div className="mt-2 flex items-start gap-1.5 text-sm">
            <Folder className="mt-0.5 size-4 shrink-0 text-text-secondary" aria-hidden="true" />
            <div className="min-w-0 [overflow-wrap:anywhere]">
              <div>{workspace}</div>
              {session.workingDir && <div className="mt-0.5 text-xs leading-4 text-text-secondary">{session.workingDir}</div>}
            </div>
          </div>
        </TooltipContent>

      </SidebarTooltip>
    </SessionActionsContextMenu>
  );
};

interface ProjectSessionGroupProps {
  onNewChat?: (path: string) => void;
  avatars?: Record<string, string>;
  group: ProjectGroup;
  activeCount?: number;
  renderSession: (session: SessionListItem) => React.ReactNode;
}

export const ProjectSessionGroup: React.FC<ProjectSessionGroupProps> = ({
  group,
  activeCount = 0,
  avatars = {},
  renderSession,
  onNewChat,
}) => {
  const agent = group.sessions.find(session => session.agentProfile)?.agentProfile;
  const intl = useIntl();
  const [expanded, setExpanded] = useState(true);
  const [displayName, setDisplayName] = useState(() => getProjectAlias(group.path, group.label));
  const [isEditing, setIsEditing] = useState(false);
  const projectPins = useProjectPins();
  const pinned = projectPins.includes(projectPathIdentity(group.path));
  const [menuOpen, setMenuOpen] = useState(false);
  const [archiveIds, setArchiveIds] = useState<string[] | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const archiveInFlight = useRef(false);
  const openProjectFolder = async () => {
    try {
      if (!(await window.electron.openDirectoryInExplorer(group.path))) {
        throw new Error(group.path);
      }
    } catch (error) {
      toast.error(intl.formatMessage({
        id: 'sessionActionsHeader.openFolderFailed',
        defaultMessage: 'Unable to open the session folder: {error}',
      }, { error: errorMessage(error) }));
    }
  };
  const prepareArchive = async () => {
    if (archiveInFlight.current) return;
    archiveInFlight.current = true;
    setArchiveBusy(true);
    try {
      const ids = new Set<string>();
      let cursor: string | null = null;
      do {
        const page = await acpListSessions(cursor, undefined, 'unified');
        page.sessions.filter(s => !s.globalConversation && !s.archivedAt && projectPathIdentity(s.workingDir) === projectPathIdentity(group.path)).forEach(s => ids.add(s.id));
        cursor = page.nextCursor;
      } while (cursor);
      setArchiveIds([...ids]);
    } catch (error) { toast.error(errorMessage(error)); }
    finally { archiveInFlight.current = false; setArchiveBusy(false); }
  };
  const confirmArchive = async () => {
    if (!archiveIds || archiveInFlight.current) return;
    archiveInFlight.current = true;
    setArchiveBusy(true);
    const remaining = [...archiveIds];
    try {
      for (const id of archiveIds) {
        await acpArchiveSession(id);
        remaining.shift();
      }
      setArchiveIds(null);
    } catch (error) {
      setArchiveIds(remaining);
      toast.error(errorMessage(error));
    } finally { archiveInFlight.current = false; setArchiveBusy(false); }
  };

  useEffect(() => {
    const persistedName = getProjectAlias(group.path, group.label);
    setDisplayName(persistedName);
    setIsEditing(false);
  }, [group.label, group.path]);

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} className="mb-1.5">
      <div
        data-workspace-row
        onContextMenu={event => { event.preventDefault(); setMenuOpen(true); }}
        className={cn(
          projectGroupLabelClassName,
          'group/project-row relative flex w-full items-center gap-1.5'
        )}
      >
        <SidebarTooltip>
          <TooltipTrigger asChild>
            <CollapsibleTrigger type="button" aria-label={displayName}
              className="flex min-h-7 min-w-0 flex-1 items-center gap-2 rounded-md text-left group-hover/project-row:pr-14 group-focus-within/project-row:pr-14 [@media(hover:none)]:pr-14 focus-visible:ring-2 focus-visible:ring-ring">
              {agent ? <AgentAvatar avatar={avatars[agent.id] ?? agent.avatar} className="size-4 shrink-0" /> :
                <Folder className="size-4 shrink-0" aria-hidden="true" />}
              <ConversationTitle>{displayName}</ConversationTitle>
            </CollapsibleTrigger>
          </TooltipTrigger>
          {!menuOpen && <TooltipContent side="right" align="start" sideOffset={8} collisionPadding={12}
            arrowClassName="invisible pointer-events-none" className={sidebarCardClass}>
            <div className="flex items-start gap-2 text-sm font-semibold leading-5">
              <Folder className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{displayName}</span>
              {pinned && <Pin className="size-3.5 shrink-0 text-text-secondary" aria-label={intl.formatMessage(i18n.pinned)} />}
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs text-text-secondary">
              <MessagesSquare className="size-4 shrink-0" aria-hidden="true" />
              {intl.formatMessage(i18n.workspaceChats, { count: group.sessions.length, active: activeCount })}
            </div>
            <div className="mt-2 border-t border-border-primary pt-2 text-xs leading-5 text-text-secondary [overflow-wrap:anywhere]">{group.path}</div>
          </TooltipContent>}
        </SidebarTooltip>

        <div className="absolute right-2 flex items-center gap-1">
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label={intl.formatMessage({ id: 'navigationPanel.projectActions', defaultMessage: 'Project actions' })}
                className="project-row-action">
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => void openProjectFolder()}>
                <FolderOpen className="size-4" />
                {intl.formatMessage({ id: 'sessionActionsHeader.openFolder', defaultMessage: 'Open folder' })}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => {
                try { setProjectPinned(group.path, !pinned); } catch (error) { toast.error(errorMessage(error)); }
              }}><Pin className="size-4" />{intl.formatMessage(pinned ? i18n.unpinProject : i18n.pinProject)}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setIsEditing(true)}>
                <Pencil className="size-4" />{intl.formatMessage(projectEditorMessages.edit)}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={archiveBusy} onSelect={() => void prepareArchive()}>
                <Archive className="size-4" />{intl.formatMessage({ id: 'navigationPanel.archiveProjectChats', defaultMessage: 'Archive conversations in project' })}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            aria-label={intl.formatMessage({ id: 'navigationPanel.newProjectChat', defaultMessage: 'New conversation in project' })}
            title={intl.formatMessage({ id: 'navigationPanel.newProjectChat', defaultMessage: 'New conversation in project' })}
            onClick={() => onNewChat?.(group.path)}
            className="project-row-action"
          >
            <MessageCirclePlus className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
      <CollapsibleContent className="codepro-disclosure-content">
        <div className="ml-3 pl-2.5 pt-1">
          {group.sessions.map((session) => renderSession(session))}
        </div>
      </CollapsibleContent>
      {isEditing && <ProjectEditor cwd={group.path} name={displayName} onClose={() => setIsEditing(false)}
        onSaveName={name => setDisplayName(saveProjectAlias(group.path, name, group.label))} />}
      <Dialog open={archiveIds !== null} onOpenChange={open => { if (!open && !archiveBusy) setArchiveIds(null); }}>
        <DialogContent><DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: 'navigationPanel.archiveProjectChats', defaultMessage: 'Archive conversations in project' })}</DialogTitle>
          <DialogDescription>{intl.formatMessage({ id: 'navigationPanel.archiveProjectConfirm', defaultMessage: 'Archive {count} conversations in {name}? Project files stay unchanged. Conversations can be restored from History.' }, { count: archiveIds?.length ?? 0, name: displayName })}</DialogDescription>
        </DialogHeader><DialogFooter>
          <button disabled={archiveBusy} onClick={() => setArchiveIds(null)}>{intl.formatMessage({ id: 'common.cancel', defaultMessage: 'Cancel' })}</button>
          <button disabled={archiveBusy || !archiveIds?.length} onClick={() => void confirmArchive()}>{intl.formatMessage({ id: 'sessions.action.archive', defaultMessage: 'Archive session' })}</button>
        </DialogFooter></DialogContent>
      </Dialog>
    </Collapsible>
  );
};

interface NavigationProps {
  className?: string;
  workspaceMode: WorkspaceMode;
  needsTrafficLightInset?: boolean;
}

export function NavigationChatsSection({
  children,
  title,
  newChat,
  menuItems,
}: {
  children: React.ReactNode;
  title?: string;
  newChat?: { label: string; open: () => void };
  menuItems?: React.ReactNode;
}) {
  const intl = useIntl();
  const [expanded, setExpanded] = useState(true);
  const section = title ?? intl.formatMessage(i18n.chats);
  const more = intl.formatMessage(i18n.sectionActions, { section });
  const actionClass = 'grid size-7 shrink-0 place-items-center rounded-md text-text-secondary hover:bg-background-secondary hover:text-text-primary focus-visible:ring-1 opacity-0 pointer-events-none group-hover/heading:opacity-100 group-hover/heading:pointer-events-auto group-has-[:focus-visible]/heading:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto';
  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} className="min-h-0 flex flex-col mt-4">
      <div className="group/heading flex min-w-0 items-center pl-4 pr-2">
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1 py-1 text-xs font-medium text-text-secondary hover:text-text-primary">
          <ChevronRight
            className={cn(
              'w-3 h-3 transition-transform motion-reduce:transition-none',
              expanded && 'rotate-90'
            )}
          />
          <span className="truncate">{section}</span>
        </CollapsibleTrigger>
        {newChat && <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className={actionClass} aria-label={more} title={more}><MoreHorizontal size={15} /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {menuItems}
              <DropdownMenuItem onSelect={() => setExpanded(!expanded)}>
                {intl.formatMessage(expanded ? i18n.collapseGroup : i18n.expandGroup)}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button type="button" className={actionClass} onClick={newChat.open} title={newChat.label} aria-label={newChat.label}>
            <MessageCirclePlus size={15} />
          </button>
        </>}
      </div>
      <CollapsibleContent className="codepro-disclosure-content min-h-0">
        <div className="pl-2 pr-1 pb-2 pt-1">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface NavigationHeaderSlotProps {
  onNewChat: () => void;
  needsTrafficLightInset?: boolean;
}

export const NavigationHeaderSlot: React.FC<NavigationHeaderSlotProps> = ({
  onNewChat,
  needsTrafficLightInset = false,
}) => {
  const intl = useIntl();
  return (
    <div
      data-testid="navigation-header-slot"
      className={cn(
        'relative z-30 flex shrink-0 flex-col px-3',
        // Native window controls keep their own row on macOS. A horizontal
        // inset cannot fit the full brand at the sidebar's minimum width.
        needsTrafficLightInset && 'pt-10'
      )}
    >
      <div className="flex h-10 min-w-0 items-center pr-12">
        <button
          type="button"
          onClick={onNewChat}
          title={intl.formatMessage({
            id: 'keyboardShortcuts.newChatLabel',
            defaultMessage: 'New Chat',
          })}
          className="no-drag shrink-0 whitespace-nowrap rounded-lg px-2 py-1 text-[15px] font-semibold tracking-tight text-text-primary transition-colors hover:text-neutral-950 dark:hover:text-neutral-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-primary"
        >
          CodeBuddy
        </button>
      </div>
    </div>
  );
};

export const Navigation: React.FC<NavigationProps> = ({
  className,
  workspaceMode,
  needsTrafficLightInset,
}) => {
  const [agentAvatars, setAgentAvatars] = useState<Record<string, string>>({});
  useEffect(() => {
    let disposed = false;
    let version = 0;
    const refresh = async () => {
      const current = ++version;
      try {
        const client = await getAcpControlClient();
        const result = await client.extMethod('_codebuddy/agents/list', {}) as unknown as { profiles: { id: string; avatar: string }[] };
        if (!disposed && current === version) setAgentAvatars(Object.fromEntries(result.profiles.map(profile => [profile.id, profile.avatar])));
      } catch { /* Keep the last known display; workspace snapshots remain the fallback. */ }
    };
    void refresh();
    window.addEventListener(AppEvents.AGENT_PROFILES_CHANGED, refresh);
    window.addEventListener('focus', refresh);
    return () => { disposed = true; window.removeEventListener(AppEvents.AGENT_PROFILES_CHANGED, refresh); window.removeEventListener('focus', refresh); };
  }, []);

  const intl = useIntl();
  const nativeTasks = useNativeSchedules();
  const scheduledSessions = useMemo(
    () => new Set<string>(nativeTasks.records.map((task) => task.sessionId)),
    [nativeTasks.records]
  );
  const reducedMotion = useReducedMotion();
  const { isNavExpanded } = useNavigationContext();
  const location = useLocation();

  const visibleItems = useMemo<NavItem[]>(() => NAV_ITEMS, []);

  const isActive = useCallback(
    (path: string) => location.pathname === withWorkspaceMode(path, workspaceMode),
    [location.pathname, workspaceMode]
  );

  const {
    recentSessions,
    recentTaskSessions,
    recentSessionsByProject,
    activeSessionId,
    fetchSessions,
    handleNavClick,
    handleSessionClick,
  } = useNavigationSessions();
  const navigate = useNavigate();
  const openDraft = (workingDir: string) => navigate(withWorkspaceMode('/pair', workspaceMode), { state: { draftOnly: true, workingDir } });
  const chooseWorkspace = async () => {
    try {
      const result = await window.electron.directoryChooser();
      if (!result.canceled && result.filePaths[0]) openDraft(result.filePaths[0]);
    } catch (error) { toast.error(errorMessage(error)); }
  };
  const pinnedProjects = useProjectPins();
  const sortedProjects = [...recentSessionsByProject].sort((a, b) => {
    const rank = (path: string) => {
      const index = pinnedProjects.indexOf(projectPathIdentity(path));
      return index < 0 ? Infinity : index;
    };
    return rank(a.path) - rank(b.path) || 0;
  });

  const [sessionStatuses, setSessionStatuses] = useState<Map<string, SessionStatus>>(new Map());
  const [petTasks, setPetTasks] = useState<PetTask[] | null>(null);
  const taskStates = useMemo(() => petTasks && new Map(
    petTasks.map(task => [task.sessionId, task.state] as const)
  ), [petTasks]);
  useEffect(() => {
    if (!window.electron?.desktopPet) return;
    let waitingForInitial = true;
    const receive = (_event: unknown, value: unknown) => {
      waitingForInitial = false;
      setPetTasks((value as PetSnapshot).tasks ?? []);
    };
    window.electron.on('pet-changed', receive);
    void window.electron.desktopPet({ action: 'get' }).then(value => {
      if (waitingForInitial) receive(null, value);
    });
    return () => {
      waitingForInitial = false;
      window.electron.off('pet-changed', receive);
    };
  }, []);

  useEffect(() => {
    const handleStatusUpdate = (event: Event) => {
      const { sessionId, streamState } = (event as CustomEvent).detail;
      setSessionStatuses((prev) => {
        const existing = prev.get(sessionId);
        // Opening history is a view transition. Only the reconciled session
        // state can conclude a turn that this window has already observed.
        if (streamState === 'loading' && existing?.streamState === 'streaming') return prev;
        const shouldMarkUnread = existing?.streamState === 'streaming' && streamState === 'idle';
        const next = new Map(prev);
        next.set(sessionId, {
          streamState,
          hasUnreadActivity: existing?.hasUnreadActivity || shouldMarkUnread,
        });
        return next;
      });
    };

    window.addEventListener(AppEvents.SESSION_STATUS_UPDATE, handleStatusUpdate);
    return () => window.removeEventListener(AppEvents.SESSION_STATUS_UPDATE, handleStatusUpdate);
  }, []);

  const clearUnread = useCallback((sessionId: string) => {
    setSessionStatuses((prev) => {
      const status = prev.get(sessionId);
      if (status?.hasUnreadActivity) {
        const next = new Map(prev);
        next.set(sessionId, { ...status, hasUnreadActivity: false });
        return next;
      }
      return prev;
    });
  }, []);

  const navFocusRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isNavExpanded) {
      fetchSessions();
      requestAnimationFrame(() => navFocusRef.current?.focus());
    }
  }, [isNavExpanded, fetchSessions]);

  const streamStateFor = (id: string): StreamState => {
    const task = taskStates?.get(id);
    if (task === 'working') return 'streaming';
    if (task === 'blocked') return 'error';
    if (task === 'completed' || task === 'input') return 'idle';
    return sessionStatuses.get(id)?.streamState ?? 'idle';
  };

  const mainTask = petTasks?.find(task => task.globalConversation);
  const mainId = mainTask?.sessionId ?? recentSessions.find(session => session.globalConversation)?.id;
  const mainActive = !!mainId && activeSessionId === mainId;
  const mainState = taskStates?.get(mainId ?? '') ??
    (mainId && sessionStatuses.get(mainId)?.streamState === 'streaming' ? 'working' : undefined);

  const renderSession = (session: SessionListItem, nested = true) => {
    const task = taskStates?.get(session.id);
    const local = sessionStatuses.get(session.id);
    return (
      <SessionRow
        key={session.id}
        session={session}
        nested={nested}
        hasSchedule={scheduledSessions.has(session.id)}
        active={session.id === activeSessionId}
        status={{
          streamState: streamStateFor(session.id),
          hasUnreadActivity: taskStates ? task === 'completed' : local?.hasUnreadActivity ?? false,
        }}
        onClick={() => {
          clearUnread(session.id);
          handleSessionClick(session.id);
        }}
        onRenamed={fetchSessions}
        onForked={handleSessionClick}
      />
    );
  };

  return (
    <motion.div
      ref={navFocusRef}
      tabIndex={-1}
      initial={false}
      animate={{ opacity: isNavExpanded ? 1 : 0 }}
      transition={{ duration: reducedMotion ? 0 : 0.18 }}
      className={cn('shell-navigation bg-background-primary outline-none flex flex-col h-full', className)}
    >
      <NavigationHeaderSlot
        onNewChat={() => handleNavClick('/')}
        needsTrafficLightInset={needsTrafficLightInset}
      />

      <div className="px-2 flex flex-col gap-0.5">
        {visibleItems.map((item) => (
          <NavRow
            key={item.id}
            item={item}
            active={isActive(item.path)}
            onClick={() => handleNavClick(item.path)}
          />
        ))}
      </div>

      <MainConversationRow onOpen={handleSessionClick} active={mainActive} taskState={mainState} />
      <div className="sidebar-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-2">
        {sortedProjects.length > 0 && (
          <NavigationChatsSection title={intl.formatMessage(i18n.workspaces)}
            newChat={{ label: intl.formatMessage(i18n.newWorkspaceChat), open: chooseWorkspace }}
            menuItems={<DropdownMenuItem onSelect={chooseWorkspace}>{intl.formatMessage(i18n.newWorkspaceChat)}</DropdownMenuItem>}>
            {sortedProjects.map((group: ProjectGroup) => (
              <ProjectSessionGroup key={group.path} group={group}
                activeCount={group.sessions.filter(s => streamStateFor(s.id) === 'streaming').length} avatars={agentAvatars} renderSession={renderSession} onNewChat={openDraft} />
            ))}
          </NavigationChatsSection>
        )}
        <NavigationChatsSection newChat={{ label: intl.formatMessage(i18n.newTaskChat), open: () => openDraft('') }}
          menuItems={<DropdownMenuItem onSelect={() => handleNavClick('/sessions')}>
            {intl.formatMessage({ id: 'navigation.itemSessions', defaultMessage: 'History' })}
          </DropdownMenuItem>}>
          {recentTaskSessions.length === 0 ? (
            <div className="px-3 py-2 text-xs text-text-secondary">
              {intl.formatMessage(i18n.noChats)}
            </div>
          ) : (
            recentTaskSessions.map((session) => renderSession(session, false))
          )}
        </NavigationChatsSection>

      </div>

      <div className="px-2 py-2">
        <NavRow
          item={SETTINGS_NAV_ITEM}
          active={isActive(SETTINGS_NAV_ITEM.path)}
          onClick={() => handleNavClick(SETTINGS_NAV_ITEM.path)}
        />
      </div>
    </motion.div>
  );
};
