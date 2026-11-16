import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { beginSessionLoadTiming } from '../acp/sessionLoadTiming';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { useChatContext } from '../contexts/ChatContext';
import { getSessionDisplayName } from '../sessions';
import { AppEvents } from '../constants/events';
import type { Session } from '../types/session';
import {
  acpGetSessionListItem,
  acpListRecentSessions,
  sessionTypeMatchesWorkspace,
  type SessionListItem,
} from '../acp/sessions';
import { groupNavigationSessions } from '../utils/projectSessions';
import { createNavigationHandler, withWorkspaceMode } from '../utils/navigationUtils';

import { rememberSidebarProjects, retainSidebarProjects, useSidebarProjects } from '../utils/sidebarProjects';
import { useSessionPins } from '../utils/sessionPins';

const MAX_RECENT_SESSIONS = 25;

export function prependUnique(
  prev: SessionListItem[],
  session: SessionListItem
): SessionListItem[] {
  if (prev.some((s) => s.id === session.id)) return prev;
  return [session, ...prev].slice(0, MAX_RECENT_SESSIONS);
}

function mergeWithEmptyLocals(
  prev: SessionListItem[],
  listed: SessionListItem[]
): SessionListItem[] {
  const emptyLocals = prev.filter(
    (local) => local.messageCount === 0 && !listed.some((s) => s.id === local.id)
  );
  return [...emptyLocals, ...listed].slice(0, MAX_RECENT_SESSIONS);
}

export function sessionToListItem(s: Session): SessionListItem {
  return {
    id: s.id,
    agentProfile: s.agent_profile,
    globalConversation: s.global_conversation,
    name: getSessionDisplayName(s),
    workingDir: s.working_dir,
    updatedAt: s.updated_at,
    messageCount: s.message_count,
    lastMessageAt: s.last_message_at ?? undefined,
    createdAt: s.created_at,
    archivedAt: s.archived_at ?? undefined,
    projectId: s.project_id ?? undefined,
    providerId: s.provider_name ?? undefined,
    modelId: s.model_config?.model_name ?? undefined,
    userSetName: s.user_set_name ?? undefined,
    hasRecipe: !!s.recipe,
    sessionType: s.session_type,
    workspaceBinding: s.extension_data.workspaceBinding as SessionListItem['workspaceBinding'],
    sidebarPlacement: s.extension_data.sidebarPlacement as SessionListItem['sidebarPlacement'],
    workspaceOrigin:
      s.extension_data.workspaceOrigin === 'default' ||
      s.extension_data.workspaceOrigin === 'selected'
        ? s.extension_data.workspaceOrigin
        : undefined,
  };
}

export function useNavigationSessions() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const chatContext = useChatContext();
  const workspaceMode = location.pathname.startsWith('/codepro') ? 'codepro' : 'code';
  const sessionWorkspaceMode = 'unified';

  const [recentSessions, setRecentSessions] = useState<SessionListItem[]>([]);
  const pinnedIds = useSessionPins();
  const [pinnedItems, setPinnedItems] = useState<SessionListItem[]>([]);
  const pinnedSessions = useMemo(() => pinnedIds.flatMap((id) => {
    const item = recentSessions.find((s) => s.id === id) ?? pinnedItems.find((s) => s.id === id);
    return item && !item.archivedAt && sessionTypeMatchesWorkspace(item.sessionType, sessionWorkspaceMode) ? [item] : [];
  }), [pinnedIds, pinnedItems, recentSessions]);
  const defaultRoot = window.appConfig?.get('CODEBUDDY_WORKSPACE_ROOT');
  const { tasks, projects } = useMemo(
    () =>
      groupNavigationSessions([...recentSessions, ...pinnedSessions.filter(s => !recentSessions.some(item => item.id === s.id))], typeof defaultRoot === 'string' ? defaultRoot : '', pinnedIds),
    [recentSessions, defaultRoot, pinnedIds, pinnedSessions]
  );
  const sidebarProjects = useSidebarProjects();
  useEffect(() => {
    try { rememberSidebarProjects(projects.map(project => project.path)); }
    catch { console.warn('Unable to save sidebar projects'); }
  }, [projects]);
  const retained = useMemo(() => retainSidebarProjects(projects, sidebarProjects), [projects, sidebarProjects]);
  const recentSessionsByProject = retained.projects;
  const recentTaskSessions = [...tasks, ...retained.hiddenSessions];
  const lastSessionIdRef = useRef<string | null>(null);

  const activeSessionId = searchParams.get('resumeSessionId') ?? undefined;
  const currentSessionId =
    location.pathname === '/pair' || location.pathname === '/codepro/pair'
      ? searchParams.get('resumeSessionId')
      : null;

  useEffect(() => {
    if (currentSessionId) {
      lastSessionIdRef.current = currentSessionId;
    }
  }, [currentSessionId]);

  useEffect(() => {
    let disposed = false;
    let version = 0;
    const refresh = async () => {
      const current = ++version;
      const items = await Promise.allSettled(pinnedIds.map((id) => acpGetSessionListItem(id)));
      if (!disposed && current === version) setPinnedItems(items.flatMap((item) => item.status === 'fulfilled' ? [item.value] : []));
    };
    void refresh();
    const changed = (event: Event) => {
      const id = (event as CustomEvent<{ sessionId: string }>).detail.sessionId;
      setPinnedItems((items) => items.filter((item) => item.id !== id));
      void refresh();
    };
    const events = [AppEvents.SESSION_ARCHIVED, AppEvents.SESSION_UNARCHIVED, AppEvents.SESSION_DELETED, AppEvents.SESSION_RENAMED];
    events.forEach((event) => window.addEventListener(event, changed));
    return () => { disposed = true; events.forEach((event) => window.removeEventListener(event, changed)); };
  }, [pinnedIds]);

  const fetchSessions = useCallback(async () => {
    try {
      const sessions = await acpListRecentSessions(MAX_RECENT_SESSIONS, sessionWorkspaceMode);
      setRecentSessions(sessions);
    } catch (error) {
      console.error('Failed to fetch sessions:', error);
    }
  }, [sessionWorkspaceMode]);

  useEffect(() => {
    const refresh = () => { void fetchSessions(); };
    window.addEventListener(AppEvents.SESSION_CONVERSATION_CHANGED, refresh);
    return () => window.removeEventListener(AppEvents.SESSION_CONVERSATION_CHANGED, refresh);
  }, [fetchSessions]);

  useEffect(() => {
    if (!activeSessionId) return;
    if (recentSessions.some((s) => s.id === activeSessionId)) return;
    let disposed = false;
    acpGetSessionListItem(activeSessionId)
      .then((item) => {
        if (disposed || item.archivedAt) return;
        setRecentSessions((prev) => prependUnique(prev, item));
      })
      .catch((error) => {
        console.error('Failed to fetch active session:', error);
      });
    return () => {
      disposed = true;
    };
  }, [activeSessionId, recentSessions]);

  useEffect(() => {
    let pollingTimeouts: ReturnType<typeof setTimeout>[] = [];
    let isPolling = false;
    let disposed = false;

    const handleSessionCreated = (event: Event) => {
      const { session } = (event as CustomEvent<{ session?: Session }>).detail || {};
      if (session && sessionTypeMatchesWorkspace(session.session_type, sessionWorkspaceMode)) {
        setRecentSessions((prev) => prependUnique(prev, sessionToListItem(session)));
      }

      if (isPolling) return;
      isPolling = true;

      const pollIntervalMs = 300;
      const maxPollDurationMs = 10000;
      const deadline = Date.now() + maxPollDurationMs;

      const pollForUpdates = async () => {
        try {
          const listed = await acpListRecentSessions(MAX_RECENT_SESSIONS, sessionWorkspaceMode);
          if (disposed) return;
          setRecentSessions((prev) => mergeWithEmptyLocals(prev, listed));
        } catch (error) {
          console.error('Failed to poll sessions:', error);
        }

        // Count request time too: slow history reads must not turn ten seconds
        // of title refresh into minutes of requests competing with a new turn.
        if (!disposed && Date.now() + pollIntervalMs < deadline) {
          const timeout = setTimeout(pollForUpdates, pollIntervalMs);
          pollingTimeouts.push(timeout);
        } else {
          isPolling = false;
        }
      };

      pollForUpdates();
    };

    window.addEventListener(AppEvents.SESSION_CREATED, handleSessionCreated);
    return () => {
      disposed = true;
      window.removeEventListener(AppEvents.SESSION_CREATED, handleSessionCreated);
      pollingTimeouts.forEach(clearTimeout);
    };
  }, [sessionWorkspaceMode]);

  useEffect(() => {
    const archived = (event: Event) => {
      const { sessionId } = (event as CustomEvent<{ sessionId: string }>).detail;
      setRecentSessions((previous) => previous.filter((session) => session.id !== sessionId));
      void fetchSessions();
    };
    window.addEventListener(AppEvents.SESSION_ARCHIVED, archived);
    window.addEventListener(AppEvents.SESSION_UNARCHIVED, fetchSessions);
    return () => {
      window.removeEventListener(AppEvents.SESSION_ARCHIVED, archived);
      window.removeEventListener(AppEvents.SESSION_UNARCHIVED, fetchSessions);
    };
  }, [fetchSessions]);

  useEffect(() => {
    let fetchVersion = 0;

    const handleSessionDeleted = (event: Event) => {
      const { sessionId } = (event as CustomEvent<{ sessionId: string }>).detail;

      setRecentSessions((prev) => prev.filter((session) => session.id !== sessionId));
      setPinnedItems((prev) => prev.filter((session) => session.id !== sessionId));
      if (currentSessionId === sessionId) navigate(withWorkspaceMode('/', workspaceMode), { replace: true });

      if (lastSessionIdRef.current === sessionId) {
        lastSessionIdRef.current = null;
      }
      const version = ++fetchVersion;
      acpListRecentSessions(MAX_RECENT_SESSIONS, sessionWorkspaceMode)
        .then((sessions) => {
          if (version !== fetchVersion) return;
          setRecentSessions(sessions.filter((session) => session.id !== sessionId));
        })
        .catch((error) => console.error('Failed to fetch sessions:', error));
    };

    const handleSessionRenamed = (event: Event) => {
      const { sessionId, newName, userInitiated } = (
        event as CustomEvent<{ sessionId: string; newName: string; userInitiated?: boolean }>
      ).detail;

      setRecentSessions((prev) =>
        prev.map((session) =>
          session.id === sessionId
            ? { ...session, name: newName, ...(userInitiated && { user_set_name: true }) }
            : session
        )
      );
    };

    window.addEventListener(AppEvents.SESSION_DELETED, handleSessionDeleted);
    window.addEventListener(AppEvents.SESSION_RENAMED, handleSessionRenamed);

    return () => {
      window.removeEventListener(AppEvents.SESSION_DELETED, handleSessionDeleted);
      window.removeEventListener(AppEvents.SESSION_RENAMED, handleSessionRenamed);
      fetchVersion++;
    };
  }, [sessionWorkspaceMode, currentSessionId, navigate, workspaceMode]);

  const handleNavClick = useCallback(
    (path: string) => {
      if (path === '/pair') {
        const sessionId =
          currentSessionId || lastSessionIdRef.current || chatContext?.chat?.sessionId;
        if (sessionId && sessionId.length > 0) {
          navigate(withWorkspaceMode(`/pair?resumeSessionId=${sessionId}`, workspaceMode));
        } else {
          navigate(withWorkspaceMode('/', workspaceMode));
        }
      } else if (path === '/custom-agents') {
        createNavigationHandler(navigate, workspaceMode, location)('custom-agents');
      } else if (path === '/toolbox') {
        const sessionId = activeSessionId || new URLSearchParams(location.search).get('sessionId');
        navigate(withWorkspaceMode(`${path}${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`, workspaceMode));
      } else if (path === '/settings') {
        navigate(withWorkspaceMode(path, workspaceMode), {
          state: { backgroundLocation: location },
        });
      } else if (path === '/schedules') {
        navigate(withWorkspaceMode(path, workspaceMode), {
          state: {
            scheduleSessionId:
              currentSessionId || lastSessionIdRef.current || chatContext?.chat?.sessionId,
          },
        });
      } else {
        navigate(withWorkspaceMode(path, workspaceMode));
      }
    },
    [navigate, currentSessionId, activeSessionId, chatContext?.chat?.sessionId, workspaceMode, location]
  );

  const handleSessionClick = useCallback(
    (sessionId: string) => {
      beginSessionLoadTiming(sessionId, 'sidebar');
      const pairPath = workspaceMode === 'codepro' ? '/codepro/pair' : '/pair';
      navigate(`${pairPath}?resumeSessionId=${sessionId}`);
    },
    [navigate, workspaceMode]
  );

  return {
    pinnedSessions,
    recentSessions,
    recentTaskSessions,
    recentSessionsByProject,
    activeSessionId,
    fetchSessions,
    handleNavClick,
    handleSessionClick,
  };
}
