import { MainConversationRow } from './MainConversationRow';
import { getAcpControlClient } from '../../acp/acpConnection';
import { AgentAvatar } from '../custom-agents/AgentAvatar';
import { useNativeSchedules } from '../../acp/nativeSchedules';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Clock3, ChevronRight, Folder, Pencil } from 'lucide-react';
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
import { InlineEditText } from '../common/InlineEditText';
import { SessionIndicators } from '../SessionIndicators';
import { acpRenameSession, type SessionListItem } from '../../acp/sessions';
import { cn } from '../../utils';
import type { ProjectGroup } from '../../utils/projectSessions';
import {
  getProjectAlias,
  PROJECT_ALIAS_MAX_LENGTH,
  saveProjectAlias,
} from '../../utils/projectAliases';
import { defineMessages, useIntl } from '../../i18n';
import { WorkspaceSwitcher, type WorkspaceMode } from '../codepro/WorkspaceSwitcher';
import { withWorkspaceMode } from '../../utils/navigationUtils';
import { isCodeProUnifiedModeEnabled } from '../../codepro/unifiedMode';
import { SessionActionsContextMenu } from '../SessionActionsHeader';

type StreamState = 'idle' | 'loading' | 'streaming' | 'error';

interface SessionStatus {
  streamState: StreamState;
  hasUnreadActivity: boolean;
}

const i18n = defineMessages({
  chats: {
    id: 'navigationPanel.chats',
    defaultMessage: 'Chats',
  },
  noChats: {
    id: 'navigationPanel.noChats',
    defaultMessage: 'No recent chats',
  },
  untitledSession: {
    id: 'navigationPanel.untitledSession',
    defaultMessage: 'Untitled session',
  },
  renameProject: {
    id: 'navigationPanel.renameProject',
    defaultMessage: 'Rename project',
  },
  projectName: {
    id: 'navigationPanel.projectName',
    defaultMessage: 'Project name',
  },
  resetProjectNameHint: {
    id: 'navigationPanel.resetProjectNameHint',
    defaultMessage: 'Clear the name to restore the folder name',
  },
});

const navItemClass = (active: boolean) =>
  cn(
    'flex flex-row items-center gap-2.5 outline-none no-drag w-full',
    'min-h-[34px] rounded-[10px] px-3 py-1.5 text-sm font-normal transition-colors',
    active
      ? 'bg-background-tertiary text-text-primary'
      : 'text-text-secondary hover:text-text-primary'
  );

export const projectGroupLabelClassName =
  'min-h-7 rounded-[10px] px-2 py-0.5 text-[13px] font-medium text-text-secondary transition-colors hover:text-text-primary';

interface NavRowProps {
  item: NavItem;
  active: boolean;
  onClick: () => void;
}

const NavRow: React.FC<NavRowProps> = ({ item, active, onClick }) => {
  const intl = useIntl();
  const Icon = item.icon;
  return (
    <button onClick={onClick} className={navItemClass(active)}>
      <Icon className="size-[18px] flex-shrink-0 text-text-secondary" />
      <span className="text-left flex-1 truncate">{getNavItemLabel(item, intl)}</span>
      {item.getTag && (
        <span className="text-xs font-mono text-text-secondary">{item.getTag()}</span>
      )}
    </button>
  );
};

interface SessionRowProps {
  hasSchedule?: boolean;
  session: SessionListItem;
  active: boolean;
  status: SessionStatus | undefined;
  onClick: () => void;
  onRenamed: () => void;
}

export const SessionRow: React.FC<SessionRowProps> = ({
  hasSchedule = false,
  session,
  active,
  status,
  onClick,
  onRenamed,
}) => {
  const intl = useIntl();
  const [isEditing, setIsEditing] = useState(false);
  // Older versions embedded the role avatar in the generated title itself.
  const role = session.agentProfile;
  const displayName = role && session.name === role.avatar + ' ' + role.name ? role.name : session.name;
  const isStreaming = status?.streamState === 'streaming';
  const hasError = status?.streamState === 'error';
  const hasUnread = status?.hasUnreadActivity ?? false;

  return (
    <SessionActionsContextMenu session={session} onSessionRenamed={onRenamed}>
      <div
        onClick={() => !isEditing && onClick()}
        className={cn(
          'group/session-row relative flex min-h-7 items-center gap-1.5 -ml-3 mr-1 pl-6 pr-2 py-1 rounded-[10px] cursor-pointer text-sm font-normal',
          'hover:text-text-primary transition-colors',
          active && 'bg-background-tertiary'
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
        <InlineEditText
          value={displayName}
          onSave={async (newName) => {
            await acpRenameSession(session.id, newName);
            window.dispatchEvent(
              new CustomEvent(AppEvents.SESSION_RENAMED, {
                detail: { sessionId: session.id, newName, userInitiated: true },
              })
            );
            onRenamed();
          }}
          placeholder={intl.formatMessage(i18n.untitledSession)}
          disabled={isStreaming}
          singleClickEdit={false}
          editButtonLabel={intl.formatMessage({
            id: 'sessionActionsHeader.renameSession',
            defaultMessage: 'Rename session',
          })}
          editButtonClassName="opacity-0 group-hover/session-row:opacity-60"
          className="truncate flex-1 !px-0 !py-0 hover:bg-transparent text-text-primary group-hover/session-row:text-neutral-950 dark:group-hover/session-row:text-neutral-50"
          editClassName="min-w-0 flex-1 !text-sm"
          onEditStart={() => setIsEditing(true)}
          onEditEnd={() => setIsEditing(false)}
        />
        <SessionIndicators isStreaming={isStreaming} hasUnread={hasUnread} hasError={hasError} />
      </div>
    </SessionActionsContextMenu>
  );
};

interface ProjectSessionGroupProps {
  avatars?: Record<string, string>;
  group: ProjectGroup;
  renderSession: (session: SessionListItem) => React.ReactNode;
}

export const ProjectSessionGroup: React.FC<ProjectSessionGroupProps> = ({
  group,
  avatars = {},
  renderSession,
}) => {
  const agent = group.sessions.find(session => session.agentProfile)?.agentProfile;
  const intl = useIntl();
  const [expanded, setExpanded] = useState(true);
  const [displayName, setDisplayName] = useState(() => getProjectAlias(group.path, group.label));
  const [draftName, setDraftName] = useState(displayName);
  const [isEditing, setIsEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const persistedName = getProjectAlias(group.path, group.label);
    setDisplayName(persistedName);
    setDraftName(persistedName);
    setIsEditing(false);
  }, [group.label, group.path]);

  useEffect(() => {
    if (!isEditing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [isEditing]);

  const commitRename = () => {
    const nextName = saveProjectAlias(group.path, draftName, group.label);
    setDisplayName(nextName);
    setDraftName(nextName);
    setIsEditing(false);
  };

  const cancelRename = () => {
    setDraftName(displayName);
    setIsEditing(false);
  };

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} className="mb-1.5">
      <div
        className={cn(
          projectGroupLabelClassName,
          'group/project-row relative flex w-full items-center gap-1.5'
        )}
      >
        <CollapsibleTrigger
          type="button"
          aria-expanded={expanded}
          aria-label={displayName}
          title={group.path}
          disabled={isEditing}
          className="absolute inset-0 w-full cursor-pointer rounded-[10px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-primary disabled:cursor-default"
        />
        <span className="pointer-events-none flex size-5 shrink-0 items-center justify-center text-text-secondary transition-colors group-hover/project-row:text-text-primary group-focus-within/project-row:text-text-primary">
          {agent ? <AgentAvatar avatar={avatars[agent.id] ?? agent.avatar} className="size-4" /> : <Folder className="size-4" aria-hidden="true" />}
        </span>
        {isEditing ? (
          <input
            ref={inputRef}
            aria-label={intl.formatMessage(i18n.projectName)}
            title={intl.formatMessage(i18n.resetProjectNameHint)}
            value={draftName}
            maxLength={PROJECT_ALIAS_MAX_LENGTH}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitRename();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                cancelRename();
              }
            }}
            className="relative min-w-0 flex-1 rounded border border-border-primary bg-background-primary px-1.5 py-0.5 text-[13px] font-medium outline-none focus:ring-1 focus:ring-ring"
          />
        ) : (
          <span className="pointer-events-none min-w-0 flex-1 truncate">{displayName}</span>
        )}
        {!isEditing && (
          <button
            type="button"
            aria-label={intl.formatMessage(i18n.renameProject)}
            title={intl.formatMessage(i18n.renameProject)}
            onClick={() => {
              setDraftName(displayName);
              setIsEditing(true);
            }}
            className="relative flex size-5 flex-shrink-0 items-center justify-center rounded text-text-secondary opacity-0 transition-[color,opacity] group-hover/project-row:opacity-60 hover:text-text-primary hover:!opacity-100 focus-visible:text-text-primary focus-visible:!opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-primary"
          >
            <Pencil className="size-3" />
          </button>
        )}
      </div>
      <CollapsibleContent className="codepro-disclosure-content">
        <div className="ml-3 pl-2.5 pt-1">{group.sessions.map(renderSession)}</div>
      </CollapsibleContent>
    </Collapsible>
  );
};

interface NavigationProps {
  className?: string;
  workspaceMode: WorkspaceMode;
  onWorkspaceModeChange: (mode: WorkspaceMode) => void;
  needsTrafficLightInset?: boolean;
}

export function NavigationChatsSection({ children }: { children: React.ReactNode }) {
  const intl = useIntl();
  const [expanded, setExpanded] = useState(true);
  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className="flex-1 min-h-0 flex flex-col mt-4"
    >
      <CollapsibleTrigger className="flex items-center gap-1 px-4 py-1 text-xs font-medium text-text-secondary hover:text-text-primary transition-colors self-start">
        <ChevronRight
          className={cn(
            'w-3 h-3 transition-transform motion-reduce:transition-none',
            expanded && 'rotate-90'
          )}
        />
        <span>{intl.formatMessage(i18n.chats)}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="codepro-disclosure-content min-h-0 h-full">
        <div className="h-full overflow-y-auto px-2 pb-2 pt-1">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface NavigationHeaderSlotProps {
  workspaceMode: WorkspaceMode;
  onWorkspaceModeChange: (mode: WorkspaceMode) => void;
  unifiedMode: boolean;
  onNewChat: () => void;
  needsTrafficLightInset?: boolean;
}

export const NavigationHeaderSlot: React.FC<NavigationHeaderSlotProps> = ({
  workspaceMode,
  onWorkspaceModeChange,
  unifiedMode,
  onNewChat,
  needsTrafficLightInset = false,
}) => {
  const intl = useIntl();
  return (
    <div
      data-testid="navigation-header-slot"
      className={cn(
        'relative z-30 flex shrink-0 flex-col px-3',
        needsTrafficLightInset && 'pl-[92px]'
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
          className="no-drag min-w-0 truncate rounded-lg px-2 py-1 text-[15px] font-semibold tracking-tight text-text-primary transition-colors hover:text-neutral-950 dark:hover:text-neutral-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-primary"
        >
          CodeBuddy
        </button>
      </div>
      {!unifiedMode && (
        <WorkspaceSwitcher
          mode={workspaceMode}
          onChange={onWorkspaceModeChange}
          unifiedMode={unifiedMode}
        />
      )}
    </div>
  );
};

export const Navigation: React.FC<NavigationProps> = ({
  className,
  workspaceMode,
  onWorkspaceModeChange,
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
  const codeProUnifiedMode = isCodeProUnifiedModeEnabled(
    window.appConfig?.get?.('CODEPRO_UNIFIED_MODE')
  );

  const visibleItems = useMemo<NavItem[]>(() => NAV_ITEMS, []);

  const isActive = useCallback(
    (path: string) => location.pathname === withWorkspaceMode(path, workspaceMode),
    [location.pathname, workspaceMode]
  );

  const {
    recentSessions,
    recentSessionsByProject,
    activeSessionId,
    fetchSessions,
    handleNavClick,
    handleSessionClick,
  } = useNavigationSessions();

  const [sessionStatuses, setSessionStatuses] = useState<Map<string, SessionStatus>>(new Map());
  const [petUnread, setPetUnread] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!window.electron?.desktopPet) return;
    const receive = (_event: unknown, value: unknown) => {
      const snapshot = value as import('../../pets/petTypes').PetSnapshot;
      // The sidebar dot and pet check consume one shared unread snapshot.
      setPetUnread(
        new Set(
          (snapshot.tasks ?? []).filter((t) => t.state === 'completed').map((t) => t.sessionId)
        )
      );
    };
    void window.electron.desktopPet({ action: 'get' }).then((value) => receive(null, value));
    window.electron.on('pet-changed', receive);
    return () => window.electron.off('pet-changed', receive);
  }, []);

  useEffect(() => {
    const handleStatusUpdate = (event: Event) => {
      const { sessionId, streamState } = (event as CustomEvent).detail;
      setSessionStatuses((prev) => {
        const existing = prev.get(sessionId);
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

  return (
    <motion.div
      ref={navFocusRef}
      tabIndex={-1}
      initial={false}
      animate={{ opacity: isNavExpanded ? 1 : 0 }}
      transition={{ duration: reducedMotion ? 0 : 0.18 }}
      className={cn('bg-background-primary outline-none flex flex-col h-full', className)}
    >
      <NavigationHeaderSlot
        workspaceMode={workspaceMode}
        onWorkspaceModeChange={onWorkspaceModeChange}
        unifiedMode={codeProUnifiedMode}
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

      <MainConversationRow onOpen={handleSessionClick} />
      <NavigationChatsSection>
        {recentSessions.length === 0 ? (
          <div className="px-3 py-2 text-xs text-text-secondary">
            {intl.formatMessage(i18n.noChats)}
          </div>
        ) : recentSessionsByProject.length > 0 ? (
          recentSessionsByProject.map((group: ProjectGroup) => (
            <ProjectSessionGroup
              key={group.path}
              group={group}
              avatars={agentAvatars}
              renderSession={(session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  hasSchedule={scheduledSessions.has(session.id)}
                  active={session.id === activeSessionId}
                  status={{
                    streamState: sessionStatuses.get(session.id)?.streamState ?? 'idle',
                    hasUnreadActivity:
                      petUnread?.has(session.id) ??
                      sessionStatuses.get(session.id)?.hasUnreadActivity ??
                      false,
                  }}
                  onClick={() => {
                    clearUnread(session.id);
                    handleSessionClick(session.id);
                  }}
                  onRenamed={fetchSessions}
                />
              )}
            />
          ))
        ) : null}
      </NavigationChatsSection>

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
