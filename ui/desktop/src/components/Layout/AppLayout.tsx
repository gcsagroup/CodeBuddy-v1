import { PanelResizeHandle } from '../../workspace-panel/PanelResizeHandle';
import { NativeScheduleDetails } from '../schedule/NativeScheduleDetails';
import { useNativeSchedulePanel } from '../schedule/useNativeSchedulePanel';
import {
  OPEN_WORKSPACE_FILE,
  OPEN_WORKSPACE_WEB,
  OPEN_GENERATION_JOB,
  type GenerationJobTarget,
  type WorkspaceFileTarget,
  type WorkspaceWebTarget,
} from '../../workspace-panel/workspaceFilePanel';
import React, { useEffect, useRef, useState } from 'react';
import { IpcRendererEvent } from 'electron';
import { Outlet, useLocation } from 'react-router-dom';
import { PanelLeft } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import { defineMessages, useIntl } from '../../i18n';
import { Button } from '../ui/button';
import ChatSessionsContainer from '../ChatSessionsContainer';
import SuspenseLoader from '../../suspense-loader';
import { useChatContext } from '../../contexts/ChatContext';
import { NavigationProvider, useNavigationContext } from './NavigationContext';
import { Navigation } from './NavigationPanel';
import { Z_INDEX } from './constants';
import { NavigationSidebar } from './NavigationSidebar';
import { cn } from '../../utils';
import { UserInput } from '../../types/message';
import type { WorkspaceMode } from '../../utils/navigationUtils';
import {
  WORKSPACE_PANEL_GAP as CODEPRO_TASK_PANEL_GAP,
  WORKSPACE_PANEL_TRANSITION,
  WorkspacePanel as CodeProTaskPanel,
  WorkspaceSubagentProvider,
  type WorkspacePanelLayout as CodeProTaskPanelLayout,
} from '../../workspace-panel/WorkspacePanel';

const i18n = defineMessages({
  openNavigation: {
    id: 'appLayout.openNavigation',
    defaultMessage: 'Open navigation',
  },
  collapseNavigation: {
    id: 'appLayout.collapseNavigation',
    defaultMessage: 'Collapse navigation',
  },
  retryFailed: {
    id: 'appLayout.retryFailed',
    defaultMessage: 'Retry failed',
  },
});

interface AppLayoutContentProps {
  activeSessions: Array<{
    sessionId: string;
    initialMessage?: UserInput;
    noAutoSubmit?: boolean;
  }>;
}

export function getCodeProChatInset(
  showCodeProTaskPanel: boolean,
  taskPanelExpanded: boolean,
  taskPanelWidth = 0,
  layout: CodeProTaskPanelLayout = 'inline'
): number | undefined {
  return showCodeProTaskPanel && taskPanelExpanded && layout === 'inline'
    ? taskPanelWidth + CODEPRO_TASK_PANEL_GAP
    : undefined;
}

export function getCodeProTaskPanelLayout(viewportWidth: number): CodeProTaskPanelLayout {
  return viewportWidth >= CODEPRO_CHAT_MIN_WIDTH + CODEPRO_PANEL_MIN_WIDTH ? 'inline' : 'drawer';
}

// CSS pixels: the essential composer controls must fit independently of ratios.
export const CODEPRO_CHAT_MIN_WIDTH = 320;
export const CODEPRO_PANEL_MIN_WIDTH = 340;
export function getCodeProPanelWidth(available: number, preferred: number | null): number {
  if (available < CODEPRO_CHAT_MIN_WIDTH + CODEPRO_PANEL_MIN_WIDTH) return available;
  return Math.max(
    CODEPRO_PANEL_MIN_WIDTH,
    Math.min(available - CODEPRO_CHAT_MIN_WIDTH, preferred ?? available / 3)
  );
}

export const CODEPRO_TASK_PANEL_EXPANDED_KEY = 'codebuddy.workspacePanel.expanded';
// Old versions persisted the automatic 560px default as if it were a user resize.
export const CODEPRO_TASK_PANEL_WIDTH_KEY = 'codebuddy.workspacePanel.splitWidth';

export function readCodeProTaskPanelPreferences(storage?: {
  getItem(key: string): string | null;
}): {
  expanded: boolean;
  width: number | null;
} {
  if (!storage) return { expanded: false, width: null };
  try {
    const widthValue = Number(storage.getItem(CODEPRO_TASK_PANEL_WIDTH_KEY));
    return {
      // Opening the app should leave room for the conversation. Expansion is
      // local to this app lifetime; keep only the user's chosen panel width.
      expanded: false,
      width:
        Number.isFinite(widthValue) && widthValue >= CODEPRO_PANEL_MIN_WIDTH ? widthValue : null,
    };
  } catch {
    return { expanded: false, width: null };
  }
}

export function shouldRestoreNavigationForWorkspace(
  previousMode: WorkspaceMode | null,
  nextMode: WorkspaceMode
): boolean {
  return nextMode === 'codepro' && previousMode !== 'codepro';
}

export function shouldShowCodeProTaskPanel(
  workspaceMode: WorkspaceMode,
  isOnPairRoute: boolean
): boolean {
  return workspaceMode === 'codepro' && isOnPairRoute;
}

const AppLayoutContent: React.FC<AppLayoutContentProps> = ({ activeSessions }) => {
  const intl = useIntl();
  const reducedMotion = useReducedMotion();
  const location = useLocation();
  const safeIsMacOS = (window?.electron?.platform || 'darwin') === 'darwin';
  const chatContext = useChatContext();
  const isOnPairRoute = location.pathname === '/pair' || location.pathname === '/codepro/pair';
  const workspaceMode: WorkspaceMode = location.pathname.startsWith('/codepro')
    ? 'codepro'
    : 'code';

  const { id: nativeScheduleId, close: closeNativeSchedule } = useNativeSchedulePanel();
  const isSchedulesRoute = location.pathname.endsWith('/schedules');
  const showNativeSchedule = Boolean(nativeScheduleId) && (isSchedulesRoute || isOnPairRoute);
  const [pendingWorkspaceOpen, setPendingWorkspaceOpen] = useState<{
    type: string;
    detail: WorkspaceFileTarget | WorkspaceWebTarget | GenerationJobTarget;
  } | null>(null);
  const currentSessionId = new URLSearchParams(location.search).get('resumeSessionId');
  useEffect(() => {
    if (!showNativeSchedule || workspaceMode !== 'codepro' || !isOnPairRoute) return;
    const open = (event: Event) => {
      const detail = (event as CustomEvent<WorkspaceFileTarget | WorkspaceWebTarget | GenerationJobTarget>).detail;
      if (!detail || detail.sessionId !== currentSessionId) return;
      setPendingWorkspaceOpen({ type: event.type, detail });
      closeNativeSchedule();
    };
    window.addEventListener(OPEN_WORKSPACE_FILE, open);
    window.addEventListener(OPEN_WORKSPACE_WEB, open);
    window.addEventListener(OPEN_GENERATION_JOB, open);
    return () => {
      window.removeEventListener(OPEN_WORKSPACE_FILE, open);
      window.removeEventListener(OPEN_WORKSPACE_WEB, open);
      window.removeEventListener(OPEN_GENERATION_JOB, open);
    };
  }, [showNativeSchedule, workspaceMode, isOnPairRoute, currentSessionId, closeNativeSchedule]);
  useEffect(() => {
    if (showNativeSchedule || !pendingWorkspaceOpen) return;
    // The child workspace has now mounted its existing event handlers. Hand
    // this explicit click over once; keep hidden terminal/save effects unmounted.
    if (
      workspaceMode === 'codepro' &&
      isOnPairRoute &&
      pendingWorkspaceOpen.detail.sessionId === currentSessionId
    )
      window.dispatchEvent(
        new CustomEvent(pendingWorkspaceOpen.type, {
          detail: pendingWorkspaceOpen.detail,
        })
      );
    setPendingWorkspaceOpen(null);
  }, [showNativeSchedule, pendingWorkspaceOpen, workspaceMode, isOnPairRoute, currentSessionId]);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [taskPanelPreferences] = useState(() =>
    readCodeProTaskPanelPreferences(typeof window === 'undefined' ? undefined : window.localStorage)
  );
  // Scope the layout to the conversation, including callbacks still completing for an older route.
  const [panels, setPanels] = useState(() => new Map<string | null, 'split' | 'full'>());
  const panelMode = panels.get(currentSessionId);
  const isCodeProTaskPanelExpanded = panelMode !== undefined;
  const isChatCollapsed = panelMode === 'full';
  const setPanelMode = (mode?: 'split' | 'full') => setPanels(previous => {
    if (previous.get(currentSessionId) === mode) return previous;
    const next = new Map(previous);
    if (mode) next.set(currentSessionId, mode);
    else next.delete(currentSessionId);
    return next;
  });
  const [codeProTaskPanelWidth, setCodeProTaskPanelWidth] = useState(taskPanelPreferences.width);
  const [isPanelResizing, setIsPanelResizing] = useState(false);
  const workAreaRef = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(() =>
    typeof window === 'undefined' ? 1440 : window.innerWidth
  );
  const previousWorkspaceMode = useRef<WorkspaceMode | null>(null);

  useEffect(() => {
    if (!safeIsMacOS) return;
    window.electron
      .getIsFullScreen()
      .then(setIsFullScreen)
      .catch(() => {});
    const handler = (_event: IpcRendererEvent, ...args: unknown[]) => {
      setIsFullScreen(Boolean(args[0]));
    };
    window.electron.on('fullscreen-change', handler);
    return () => window.electron.off('fullscreen-change', handler);
  }, [safeIsMacOS]);

  useEffect(() => {
    const element = workAreaRef.current;
    if (!element) return;
    const measure = () => setAvailableWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    try {
      if (codeProTaskPanelWidth !== null) {
        window.localStorage.setItem(CODEPRO_TASK_PANEL_WIDTH_KEY, String(codeProTaskPanelWidth));
      }
    } catch {
      // Preferences are optional when storage is unavailable.
    }
  }, [codeProTaskPanelWidth]);

  const { isNavExpanded, setIsNavExpanded } = useNavigationContext();
  const navigationToggleRef = useRef<HTMLButtonElement>(null);
  const handleNavigationExpandedChange = (expanded: boolean) => {
    setIsNavExpanded(expanded);
    if (!expanded) requestAnimationFrame(() => navigationToggleRef.current?.focus());
  };

  useEffect(() => {
    if (shouldRestoreNavigationForWorkspace(previousWorkspaceMode.current, workspaceMode)) {
      setIsNavExpanded(true);
    }
    previousWorkspaceMode.current = workspaceMode;
  }, [setIsNavExpanded, workspaceMode]);

  if (!chatContext) {
    throw new Error('AppLayoutContent must be used within ChatProvider');
  }

  const { setChat } = chatContext;

  const needsTrafficLightInset = safeIsMacOS && !isFullScreen;
  const navToggleTitle = intl.formatMessage(
    isNavExpanded ? i18n.collapseNavigation : i18n.openNavigation
  );
  const showCodeProTaskPanel =
    !showNativeSchedule &&
    shouldShowCodeProTaskPanel(workspaceMode, isOnPairRoute || location.pathname === '/codepro');
  const codeProTaskPanelLayout = getCodeProTaskPanelLayout(availableWidth);
  const splitWidth = getCodeProPanelWidth(availableWidth, codeProTaskPanelWidth);
  const chatHidden =
    (showNativeSchedule && codeProTaskPanelLayout === 'drawer') ||
    (showCodeProTaskPanel &&
      isCodeProTaskPanelExpanded &&
      (isChatCollapsed || codeProTaskPanelLayout === 'drawer'));
  const panelWidth = chatHidden ? availableWidth : splitWidth;
  const changeChatCollapsed = (collapsed: boolean) => {
    setPanelMode(collapsed ? 'full' : codeProTaskPanelLayout === 'drawer' ? undefined : 'split');
  };
  const resizePanel = (requested: number, commit = true) => {
    setIsPanelResizing(!commit);
    if (commit && requested < CODEPRO_PANEL_MIN_WIDTH) {
      setPanelMode();
    } else if (commit && requested > availableWidth - CODEPRO_CHAT_MIN_WIDTH) {
      setPanelMode('full');
    } else {
      if (requested <= availableWidth - CODEPRO_CHAT_MIN_WIDTH) setPanelMode('split');
      setCodeProTaskPanelWidth(getCodeProPanelWidth(availableWidth, requested));
    }
  };
  const resetPanelWidth = () => {
    setCodeProTaskPanelWidth(null);
    if (isChatCollapsed) setPanelMode('split');
    try {
      window.localStorage.removeItem(CODEPRO_TASK_PANEL_WIDTH_KEY);
    } catch {
      /* Optional preference. */
    }
  };


  return (
    <div
      className="isolate flex flex-1 w-full h-full relative animate-fade-in bg-background-primary flex-row"
      style={
        {
          '--navigation-toolbar-inset': isNavExpanded
            ? '24px'
            : needsTrafficLightInset
              ? '144px'
              : '64px',
        } as React.CSSProperties
      }
    >
      {/* The sidebar shares the canvas and uses only its resize divider. */}
      <div className="flex flex-1 w-full h-full min-h-0 flex-row">
        <NavigationSidebar
          expanded={isNavExpanded}
          onExpandedChange={handleNavigationExpandedChange}
        >
          <Navigation
            workspaceMode={workspaceMode}
            needsTrafficLightInset={needsTrafficLightInset}
          />
        </NavigationSidebar>

        <div className="relative w-0 shrink-0" style={{ zIndex: Z_INDEX.HEADER }}>
          <Button
            ref={navigationToggleRef}
            onClick={() => handleNavigationExpandedChange(!isNavExpanded)}
            className={cn(
              'no-drag absolute top-2 text-text-secondary hover:!bg-background-tertiary hover:text-text-primary',
              isNavExpanded ? '-left-12' : needsTrafficLightInset ? 'left-[96px]' : 'left-3'
            )}
            variant="ghost"
            size="xs"
            title={navToggleTitle}
            aria-label={navToggleTitle}
            aria-expanded={isNavExpanded}
          >
            <PanelLeft className="size-[18px]" />
          </Button>
        </div>

        {/* Main content — no border / no card; just flows on the canvas. */}
        <WorkspaceSubagentProvider expanded={showCodeProTaskPanel && isCodeProTaskPanelExpanded}>
          <div
            ref={workAreaRef}
            className="shell-work-area relative flex flex-col flex-1 min-w-0 overflow-hidden min-h-0"
            data-navigation-overlay={!isNavExpanded && chatHidden}
          >
            {/* Full-width panes need a separate row for the navigation toggle. */}
            <div className="shell-work-canvas relative flex-1 min-h-0">
              <div
                style={{
                  width: chatHidden
                    ? 0
                    : availableWidth -
                      (getCodeProChatInset(
                        showCodeProTaskPanel || showNativeSchedule,
                        isCodeProTaskPanelExpanded || showNativeSchedule,
                        panelWidth,
                        codeProTaskPanelLayout
                      ) ?? 0),
                }}
                className="h-full min-w-0 overflow-hidden min-h-0"
                aria-hidden={chatHidden}
                inert={chatHidden}
              >
                {/* Chat headers already reserve the toggle's horizontal space. Other pages
                  need a separate row so their own headings never sit underneath it. */}
                <div
                  className={cn('h-full', !isNavExpanded && !isOnPairRoute && 'pt-10')}
                  style={{ minWidth: CODEPRO_CHAT_MIN_WIDTH }}
                >
                  <React.Suspense fallback={<SuspenseLoader />}>
                    <Outlet />
                  </React.Suspense>
                  {/* Always render ChatSessionsContainer to keep SSE connections alive.
              When navigating away from /pair, hide it with CSS */}
                  <div className={isOnPairRoute ? 'contents' : 'hidden'}>
                    <ChatSessionsContainer
                      setChat={setChat}
                      activeSessions={activeSessions}
                      isChatVisible={isOnPairRoute}
                    />
                  </div>
                </div>
              </div>
              {showNativeSchedule && nativeScheduleId && (
                <motion.aside
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{
                    ...WORKSPACE_PANEL_TRANSITION,
                    duration: reducedMotion ? 0 : WORKSPACE_PANEL_TRANSITION.duration,
                  }}
                  className="absolute bottom-0 right-0 top-0 z-20 min-h-0 overflow-hidden border-l border-border-primary bg-background-primary"
                  style={{
                    width: codeProTaskPanelLayout === 'drawer' ? availableWidth : panelWidth,
                  }}
                >
                  {codeProTaskPanelLayout === 'inline' && (
                    <PanelResizeHandle
                      width={panelWidth}
                      resizing={isPanelResizing}
                      onWidthChange={(requested, commit = true) => {
                        setIsPanelResizing(!commit);
                        setCodeProTaskPanelWidth(getCodeProPanelWidth(availableWidth, requested));
                      }}
                      onResetWidth={resetPanelWidth}
                    />
                  )}
                  <NativeScheduleDetails
                    key={nativeScheduleId}
                    id={nativeScheduleId}
                    onClose={closeNativeSchedule}
                  />
                </motion.aside>
              )}
              {showCodeProTaskPanel && (
                <CodeProTaskPanel
                  expanded={isCodeProTaskPanelExpanded}
                  layout={codeProTaskPanelLayout}
                  onExpandedChange={(expanded) => setPanelMode(expanded ? 'split' : undefined)}
                  width={panelWidth}
                  resizing={isPanelResizing}
                  onWidthChange={resizePanel}
                  chatCollapsed={chatHidden}
                  onChatCollapsedChange={changeChatCollapsed}
                  onResetWidth={resetPanelWidth}
                />
              )}
            </div>
          </div>
        </WorkspaceSubagentProvider>
      </div>
    </div>
  );
};

interface AppLayoutProps {
  activeSessions: Array<{
    sessionId: string;
    initialMessage?: UserInput;
    noAutoSubmit?: boolean;
  }>;
}

export const AppLayout: React.FC<AppLayoutProps> = ({ activeSessions }) => {
  return (
    <NavigationProvider>
      <AppLayoutContent activeSessions={activeSessions} />
    </NavigationProvider>
  );
};
