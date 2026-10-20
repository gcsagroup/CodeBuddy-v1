import React, { useEffect, useRef, useState } from 'react';
import { IpcRendererEvent } from 'electron';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { PanelLeft } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import { defineMessages, useIntl } from '../../i18n';
import { Button } from '../ui/button';
import ChatSessionsContainer from '../ChatSessionsContainer';
import { useChatContext } from '../../contexts/ChatContext';
import { NavigationProvider, useNavigationContext } from './NavigationContext';
import { Navigation } from './NavigationPanel';
import { Z_INDEX } from './constants';
import { NavigationSidebar } from './NavigationSidebar';
import { cn } from '../../utils';
import { UserInput } from '../../types/message';
import type { WorkspaceMode } from '../codepro/WorkspaceSwitcher';
import {
  WORKSPACE_PANEL_GAP as CODEPRO_TASK_PANEL_GAP,
  WORKSPACE_PANEL_TRANSITION,
  WorkspacePanel as CodeProTaskPanel,
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
  if (!storage) return { expanded: true, width: null };
  try {
    const expandedValue = storage.getItem(CODEPRO_TASK_PANEL_EXPANDED_KEY);
    const widthValue = Number(storage.getItem(CODEPRO_TASK_PANEL_WIDTH_KEY));
    return {
      expanded: expandedValue !== 'false',
      width:
        Number.isFinite(widthValue) && widthValue >= CODEPRO_PANEL_MIN_WIDTH ? widthValue : null,
    };
  } catch {
    return { expanded: true, width: null };
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
  const navigate = useNavigate();
  const safeIsMacOS = (window?.electron?.platform || 'darwin') === 'darwin';
  const chatContext = useChatContext();
  const isOnPairRoute = location.pathname === '/pair' || location.pathname === '/codepro/pair';
  const workspaceMode: WorkspaceMode = location.pathname.startsWith('/codepro')
    ? 'codepro'
    : 'code';

  const [isFullScreen, setIsFullScreen] = useState(false);
  const [taskPanelPreferences] = useState(() =>
    readCodeProTaskPanelPreferences(typeof window === 'undefined' ? undefined : window.localStorage)
  );
  const [isCodeProTaskPanelExpanded, setIsCodeProTaskPanelExpanded] = useState(
    taskPanelPreferences.expanded
  );
  const [codeProTaskPanelWidth, setCodeProTaskPanelWidth] = useState(taskPanelPreferences.width);
  const [isChatCollapsed, setIsChatCollapsed] = useState(false);
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
      window.localStorage.setItem(
        CODEPRO_TASK_PANEL_EXPANDED_KEY,
        String(isCodeProTaskPanelExpanded)
      );
      if (codeProTaskPanelWidth !== null) {
        window.localStorage.setItem(CODEPRO_TASK_PANEL_WIDTH_KEY, String(codeProTaskPanelWidth));
      }
    } catch {
      // Preferences are optional when storage is unavailable.
    }
  }, [codeProTaskPanelWidth, isCodeProTaskPanelExpanded]);

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
  const showCodeProTaskPanel = shouldShowCodeProTaskPanel(
    workspaceMode,
    isOnPairRoute || location.pathname === '/codepro'
  );
  const codeProTaskPanelLayout = getCodeProTaskPanelLayout(availableWidth);
  const splitWidth = getCodeProPanelWidth(availableWidth, codeProTaskPanelWidth);
  const chatHidden =
    showCodeProTaskPanel &&
    isCodeProTaskPanelExpanded &&
    (isChatCollapsed || codeProTaskPanelLayout === 'drawer');
  const panelWidth = chatHidden ? availableWidth : splitWidth;
  const changeChatCollapsed = (collapsed: boolean) => {
    setIsChatCollapsed(collapsed);
    if (!collapsed && codeProTaskPanelLayout === 'drawer') setIsCodeProTaskPanelExpanded(false);
  };
  const resizePanel = (requested: number, commit = true) => {
    setIsPanelResizing(!commit);
    if (commit && requested < CODEPRO_PANEL_MIN_WIDTH) {
      setIsCodeProTaskPanelExpanded(false);
      setIsChatCollapsed(false);
    } else if (commit && requested > availableWidth - CODEPRO_CHAT_MIN_WIDTH) {
      setIsChatCollapsed(true);
    } else {
      if (requested <= availableWidth - CODEPRO_CHAT_MIN_WIDTH) setIsChatCollapsed(false);
      setCodeProTaskPanelWidth(getCodeProPanelWidth(availableWidth, requested));
    }
  };
  const resetPanelWidth = () => {
    setCodeProTaskPanelWidth(null);
    setIsChatCollapsed(false);
    try {
      window.localStorage.removeItem(CODEPRO_TASK_PANEL_WIDTH_KEY);
    } catch {
      /* Optional preference. */
    }
  };

  return (
    <div
      className="flex flex-1 w-full h-full relative animate-fade-in bg-background-primary flex-row"
      style={
        {
          '--navigation-toolbar-inset': needsTrafficLightInset && !isNavExpanded ? '144px' : '64px',
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
            onWorkspaceModeChange={(nextMode) =>
              navigate(nextMode === 'codepro' ? '/codepro' : '/')
            }
          />
        </NavigationSidebar>

        <div className="relative w-0 shrink-0" style={{ zIndex: Z_INDEX.HEADER }}>
          <Button
            ref={navigationToggleRef}
            onClick={() => handleNavigationExpandedChange(!isNavExpanded)}
            className={cn(
              'no-drag absolute top-2 text-text-secondary hover:!bg-background-tertiary hover:text-text-primary',
              needsTrafficLightInset && !isNavExpanded ? 'left-[96px]' : 'left-3'
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
        <div ref={workAreaRef} className="relative flex-1 min-w-0 overflow-hidden min-h-0">
          <motion.div
            initial={false}
            animate={{
              width: chatHidden
                ? 0
                : availableWidth -
                  (getCodeProChatInset(
                    showCodeProTaskPanel,
                    isCodeProTaskPanelExpanded,
                    panelWidth,
                    codeProTaskPanelLayout
                  ) ?? 0),
            }}
            transition={{
              ...WORKSPACE_PANEL_TRANSITION,
              duration: isPanelResizing || reducedMotion ? 0 : WORKSPACE_PANEL_TRANSITION.duration,
            }}
            className="h-full min-w-0 overflow-hidden min-h-0"
            aria-hidden={chatHidden}
            inert={chatHidden}
          >
            <div className="h-full" style={{ minWidth: CODEPRO_CHAT_MIN_WIDTH }}>
              <Outlet />
              {/* Always render ChatSessionsContainer to keep SSE connections alive.
              When navigating away from /pair, hide it with CSS */}
              <div className={isOnPairRoute ? 'contents' : 'hidden'}>
                <ChatSessionsContainer setChat={setChat} activeSessions={activeSessions} isChatVisible={isOnPairRoute} />
              </div>
            </div>
          </motion.div>
          {showCodeProTaskPanel && (
            <CodeProTaskPanel
              expanded={isCodeProTaskPanelExpanded}
              layout={codeProTaskPanelLayout}
              onExpandedChange={(expanded) => {
                setIsCodeProTaskPanelExpanded(expanded);
                setIsChatCollapsed(false);
              }}
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
