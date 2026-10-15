import { useEffect, useState, useRef } from 'react';
import { IpcRendererEvent } from 'electron';
import {
  HashRouter,
  Routes,
  Route,
  Navigate,
  useNavigate,
  useLocation,
  useSearchParams,
} from 'react-router-dom';
import { importNostrSessionFromDeepLink } from './sessionLinks';
import { ErrorUI } from './components/ErrorBoundary';
import { ExtensionInstallModal } from './components/ExtensionInstallModal';
import RecipeParamsModalContainer from './components/RecipeParamsModalContainer';
import { isRecipeParamsCancelled } from './acp/errors';
import { toast, ToastContainer } from 'react-toastify';
import AnnouncementModal from './components/AnnouncementModal';
import TelemetryConsentPrompt from './components/TelemetryConsentPrompt';
import OnboardingGuard from './components/onboarding/OnboardingGuard';
import { createSession } from './sessions';
import { acpListSessions, acpDeleteSession } from './acp/sessions';

import { ChatType } from './types/chat';
import Hub from './components/Hub';
import { UserInput } from './types/message';

interface PairRouteState {
  workingDir?: string;
  resumeSessionId?: string;
  initialMessage?: UserInput;
  noAutoSubmit?: boolean;
  recipeDeeplink?: string;
  recipeId?: string;
}
import SettingsView, { SettingsViewOptions } from './components/settings/SettingsView';
import SessionsView from './components/sessions/SessionsView';
import SchedulesView from './components/schedule/SchedulesView';
import ProviderSettings from './components/settings/providers/ProviderSettingsPage';
import { AppLayout } from './components/Layout/AppLayout';
import { ChatProvider, DEFAULT_CHAT_TITLE } from './contexts/ChatContext';
import LauncherView from './components/LauncherView';

import 'react-toastify/dist/ReactToastify.css';
import { useConfig } from './components/ConfigContext';
import { ModelAndProviderProvider } from './components/ModelAndProviderContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { FeaturesProvider } from './contexts/FeaturesContext';
import PermissionSettingsView from './components/settings/permission/PermissionSetting';

import RecipesView from './components/recipes/RecipesView';
import ToolboxView from './components/toolbox/ToolboxView';
import SkillsView from './components/skills/SkillsView';
import StandaloneAppView from './components/apps/StandaloneAppView';
import {
  getWorkspaceModeFromPath,
  View,
  ViewOptions,
  withWorkspaceMode,
} from './utils/navigationUtils';
import { isCodeProUnifiedModeEnabled, resolveCodeProEntryPath } from './codepro/unifiedMode';

import { useNavigation } from './hooks/useNavigation';
import { errorMessage } from './utils/conversionUtils';
import { getInitialWorkingDir, runWithOrdinaryWorkingDir } from './utils/workingDir';
import { usePageViewTracking } from './hooks/useAnalytics';
import { trackErrorWithContext } from './utils/analytics';
import { AppEvents } from './constants/events';
import { registerPlatformEventHandlers } from './utils/platform_events';
import { reconnectAcpAfterSystemResume } from './acp/acpConnection';
import { isSupportedSessionShareDeepLink } from './utils/deepLinkProtocol';
import { defineMessages, useIntl } from './i18n';
import { CodeProHub } from './components/codepro/CodeProHub';
import { CodeProRouteGuard } from './codepro/CodeProRouteGuard';
import { getLegacyToolboxRedirect } from './utils/toolboxRouting';

const i18n = defineMessages({
  toastNotifications: {
    id: 'app.toastNotifications',
    defaultMessage: 'Toast notifications',
  },
  workspaceSelectionCancelled: {
    id: 'app.workspaceSelectionCancelled',
    defaultMessage: 'Select a project folder to start this conversation. No session was created.',
  },
  chooseFolder: {
    id: 'app.chooseFolder',
    defaultMessage: 'Choose folder',
  },
});

function PageViewTracker() {
  usePageViewTracking();
  return null;
}

// Route Components
const HubRouteWrapper = () => {
  const setView = useNavigation();
  return <Hub setView={setView} />;
};

export function resolveSessionInitialMessage(
  session: { recipe?: { prompt?: string | null } | null },
  initialMessage?: UserInput
): UserInput | undefined {
  return (
    initialMessage ??
    (session.recipe?.prompt ? { msg: session.recipe.prompt, images: [] } : undefined)
  );
}

export const PairRouteWrapper = ({
  activeSessions,
}: {
  activeSessions: Array<{
    sessionId: string;
    initialMessage?: UserInput;
    noAutoSubmit?: boolean;
  }>;
  setActiveSessions: (
    sessions: Array<{ sessionId: string; initialMessage?: UserInput; noAutoSubmit?: boolean }>
  ) => void;
}) => {
  const intl = useIntl();
  const { extensionsList } = useConfig();
  const location = useLocation();
  const routeState =
    (location.state as PairRouteState) || (window.history.state as PairRouteState) || {};
  const [searchParams, setSearchParams] = useSearchParams();
  const isCreatingSessionRef = useRef(false);
  const [workspaceSelectionCancelled, setWorkspaceSelectionCancelled] = useState(false);
  const [workspaceSelectionAttempt, setWorkspaceSelectionAttempt] = useState(0);

  const resumeSessionId = searchParams.get('resumeSessionId') ?? undefined;
  const configuredRecipeDeeplink = window.appConfig?.get('recipeDeeplink');
  const configuredRecipeId = window.appConfig?.get('recipeId');
  const recipeDeeplinkFromConfig =
    typeof configuredRecipeDeeplink === 'string' ? configuredRecipeDeeplink : undefined;
  const recipeIdFromConfig =
    typeof configuredRecipeId === 'string' ? configuredRecipeId : undefined;
  const recipeDeeplinkFromRoute =
    typeof routeState.recipeDeeplink === 'string' ? routeState.recipeDeeplink : undefined;
  const recipeIdFromRoute =
    typeof routeState.recipeId === 'string' ? routeState.recipeId : undefined;
  const hasRouteRecipe = recipeDeeplinkFromRoute !== undefined || recipeIdFromRoute !== undefined;
  const recipeDeeplink = hasRouteRecipe ? recipeDeeplinkFromRoute : recipeDeeplinkFromConfig;
  const recipeId = hasRouteRecipe ? recipeIdFromRoute : recipeIdFromConfig;
  const workspaceMode = getWorkspaceModeFromPath(location.pathname);
  const initialMessage = routeState.initialMessage;
  const noAutoSubmit = routeState.noAutoSubmit;
  const launchWorkingDir =
    typeof routeState.workingDir === 'string' ? routeState.workingDir : undefined;
  const hasFreshCodeProLaunchIntent =
    workspaceMode === 'codepro' &&
    !resumeSessionId &&
    Boolean(initialMessage || recipeDeeplink || recipeId);

  // Create session if we have an initialMessage, recipeDeeplink, or recipeId but no sessionId
  useEffect(() => {
    if (hasFreshCodeProLaunchIntent) return;
    if (
      (initialMessage || recipeDeeplink || recipeId) &&
      !resumeSessionId &&
      !isCreatingSessionRef.current
    ) {
      isCreatingSessionRef.current = true;

      (async () => {
        try {
          const launch = await runWithOrdinaryWorkingDir(
            launchWorkingDir ?? getInitialWorkingDir(),
            (workingDir) =>
              createSession(workingDir, {
                recipeDeeplink,
                recipeId,
                allExtensions: extensionsList,
                workspaceMode: 'code',
              })
          );
          if (!launch) {
            setWorkspaceSelectionCancelled(true);
            return;
          }
          setWorkspaceSelectionCancelled(false);
          const newSession = launch.value;
          const sessionInitialMessage = resolveSessionInitialMessage(newSession, initialMessage);

          window.dispatchEvent(
            new CustomEvent(AppEvents.ADD_ACTIVE_SESSION, {
              detail: {
                sessionId: newSession.id,
                initialMessage: sessionInitialMessage,
                noAutoSubmit,
              },
            })
          );

          setSearchParams((prev) => {
            prev.set('resumeSessionId', newSession.id);
            return prev;
          });
        } catch (error) {
          if (isRecipeParamsCancelled(error)) {
            setWorkspaceSelectionCancelled(true);
            return;
          }
          console.error('Failed to create session:', error);
          trackErrorWithContext(error, {
            component: 'PairRouteWrapper',
            action: 'create_session',
            recoverable: true,
          });
        } finally {
          isCreatingSessionRef.current = false;
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    initialMessage,
    recipeDeeplink,
    recipeId,
    resumeSessionId,
    setSearchParams,
    extensionsList,
    workspaceSelectionAttempt,
    workspaceMode,
    hasFreshCodeProLaunchIntent,
    launchWorkingDir,
  ]);

  // Add resumed session to active sessions if not already there
  useEffect(() => {
    if (resumeSessionId && !activeSessions.some((s) => s.sessionId === resumeSessionId)) {
      window.dispatchEvent(
        new CustomEvent(AppEvents.ADD_ACTIVE_SESSION, {
          detail: {
            sessionId: resumeSessionId,
            initialMessage: initialMessage,
            noAutoSubmit,
          },
        })
      );
    }
  }, [resumeSessionId, activeSessions, initialMessage, noAutoSubmit]);

  if (hasFreshCodeProLaunchIntent) {
    return (
      <CodeProHub
        launchIntent={{
          initialMessage,
          recipeDeeplink,
          recipeId,
          noAutoSubmit,
          ...(launchWorkingDir ? { workingDir: launchWorkingDir } : {}),
        }}
      />
    );
  }

  if (workspaceSelectionCancelled) {
    return (
      <div className="m-4 rounded-md border border-border bg-background-muted p-4 text-sm">
        <p>{intl.formatMessage(i18n.workspaceSelectionCancelled)}</p>
        <button
          type="button"
          className="mt-3 rounded bg-background-primary px-3 py-2"
          onClick={() => {
            setWorkspaceSelectionCancelled(false);
            setWorkspaceSelectionAttempt((attempt) => attempt + 1);
          }}
        >
          {intl.formatMessage(i18n.chooseFolder)}
        </button>
      </div>
    );
  }

  return null;
};

const SettingsRoute = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const setView = useNavigation();

  // Get viewOptions from location.state, history.state, or URL search params
  const viewOptions =
    (location.state as SettingsViewOptions) || (window.history.state as SettingsViewOptions) || {};

  // If section is provided via URL search params, add it to viewOptions
  const sectionFromUrl = searchParams.get('section');
  if (sectionFromUrl) {
    viewOptions.section = sectionFromUrl;
  }

  const homePath = location.pathname.startsWith('/codepro') ? '/codepro' : '/';
  const backgroundLocation = (location.state as ViewOptions | null)?.backgroundLocation;
  return (
    <SettingsView
      onClose={() => (backgroundLocation ? navigate(-1) : navigate(homePath))}
      setView={setView}
      viewOptions={viewOptions}
    />
  );
};

const SessionsRoute = () => {
  return <SessionsView />;
};

const SchedulesRoute = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const homePath = location.pathname.startsWith('/codepro') ? '/codepro' : '/';
  return <SchedulesView onClose={() => navigate(homePath)} />;
};

const RecipesRoute = () => {
  return <RecipesView />;
};

const LegacyToolboxRoute = () => {
  const location = useLocation();
  return (
    <Navigate
      replace
      to={getLegacyToolboxRedirect(location.pathname, location.search)}
      state={location.state}
    />
  );
};

const PermissionRoute = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const workspaceMode = getWorkspaceModeFromPath(location.pathname);
  const parentView = location.state?.parentView as View;
  const parentViewOptions = location.state?.parentViewOptions as ViewOptions;

  return (
    <PermissionSettingsView
      onClose={() => {
        // Navigate back to parent view with options
        switch (parentView) {
          case 'chat':
            navigate(withWorkspaceMode('/', workspaceMode));
            break;
          case 'pair':
            navigate(withWorkspaceMode('/pair', workspaceMode));
            break;
          case 'settings':
            navigate(withWorkspaceMode('/settings', workspaceMode), {
              state: parentViewOptions,
            });
            break;
          case 'sessions':
            navigate(withWorkspaceMode('/sessions', workspaceMode));
            break;
          case 'schedules':
            navigate(withWorkspaceMode('/schedules', workspaceMode));
            break;
          case 'recipes':
            navigate(withWorkspaceMode('/recipes', workspaceMode));
            break;
          case 'skills':
            navigate(withWorkspaceMode('/skills', workspaceMode));
            break;
          default:
            navigate(withWorkspaceMode('/', workspaceMode));
        }
      }}
    />
  );
};

const ConfigureProvidersRoute = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const workspaceMode = getWorkspaceModeFromPath(location.pathname);

  return (
    <div className="w-screen h-screen bg-background-primary">
      <ProviderSettings
        onClose={() =>
          navigate(withWorkspaceMode('/settings', workspaceMode), {
            state: { section: 'models' },
          })
        }
        isOnboarding={false}
      />
    </div>
  );
};

export function AppInner() {
  const intl = useIntl();
  const [fatalError, setFatalError] = useState<string | null>(null);
  const codeProUnifiedMode = isCodeProUnifiedModeEnabled(
    window.appConfig?.get?.('CODEPRO_UNIFIED_MODE')
  );

  const nostrImportInFlight = useRef<string | null>(null);

  const navigate = useNavigate();
  const location = useLocation();
  const setView = useNavigation();
  const isSettingsRoute =
    location.pathname === '/settings' || location.pathname === '/codepro/settings';
  const settingsBackgroundLocation = isSettingsRoute
    ? (location.state as ViewOptions | null)?.backgroundLocation
    : undefined;

  const [chat, setChat] = useState<ChatType>({
    sessionId: '',
    name: DEFAULT_CHAT_TITLE,
    messages: [],
    recipe: null,
  });

  const MAX_ACTIVE_SESSIONS = 10;

  const [activeSessions, setActiveSessions] = useState<
    Array<{ sessionId: string; initialMessage?: UserInput; noAutoSubmit?: boolean }>
  >([]);

  useEffect(() => {
    const handleAddActiveSession = (event: Event) => {
      const { sessionId, initialMessage, noAutoSubmit } = (
        event as CustomEvent<{
          sessionId: string;
          initialMessage?: UserInput;
          noAutoSubmit?: boolean;
        }>
      ).detail;

      setActiveSessions((prev) => {
        const existingIndex = prev.findIndex((s) => s.sessionId === sessionId);

        if (existingIndex !== -1) {
          // Session exists - move to end of LRU list (most recently used)
          const existing = prev[existingIndex];
          return [...prev.slice(0, existingIndex), ...prev.slice(existingIndex + 1), existing];
        }

        // New session - add to end with LRU eviction if needed
        const newSession = { sessionId, initialMessage, noAutoSubmit };
        const updated = [...prev, newSession];
        if (updated.length > MAX_ACTIVE_SESSIONS) {
          return updated.slice(updated.length - MAX_ACTIVE_SESSIONS);
        }
        return updated;
      });
    };

    const handleClearInitialMessage = (event: Event) => {
      const { sessionId } = (event as CustomEvent<{ sessionId: string }>).detail;

      setActiveSessions((prev) => {
        return prev.map((session) => {
          if (session.sessionId === sessionId) {
            return { ...session, initialMessage: undefined };
          }
          return session;
        });
      });
    };

    const handleSessionDeleted = (event: Event) => {
      const { sessionId } = (event as CustomEvent<{ sessionId: string }>).detail;

      setActiveSessions((prev) => {
        return prev.filter((session) => session.sessionId !== sessionId);
      });
    };

    window.addEventListener(AppEvents.ADD_ACTIVE_SESSION, handleAddActiveSession);
    window.addEventListener(AppEvents.CLEAR_INITIAL_MESSAGE, handleClearInitialMessage);
    window.addEventListener(AppEvents.SESSION_DELETED, handleSessionDeleted);
    return () => {
      window.removeEventListener(AppEvents.ADD_ACTIVE_SESSION, handleAddActiveSession);
      window.removeEventListener(AppEvents.CLEAR_INITIAL_MESSAGE, handleClearInitialMessage);
      window.removeEventListener(AppEvents.SESSION_DELETED, handleSessionDeleted);
    };
  }, []);

  const { addExtension } = useConfig();

  useEffect(() => {
    try {
      window.electron.reactReady();
    } catch (error) {
      console.error('Error sending reactReady:', error);
      setFatalError(`React ready notification failed: ${errorMessage(error, 'Unknown error')}`);
    }
  }, []);

  useEffect(() => {
    const handleSystemResume = () => reconnectAcpAfterSystemResume();
    window.electron.on('system-resume', handleSystemResume);
    return () => window.electron.off('system-resume', handleSystemResume);
  }, []);

  useEffect(() => {
    acpListSessions()
      .then(({ sessions }) => {
        const phantom = sessions.filter(
          (s) => s.messageCount === 0 && !s.userSetName && !s.hasRecipe
        );
        for (const s of phantom) {
          acpDeleteSession(s.id).catch(() => {});
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const handleOpenSharedSession = async (_event: IpcRendererEvent, ...args: unknown[]) => {
      const link = args[0] as string;
      window.electron.logInfo('Opening session share link');

      if (!isSupportedSessionShareDeepLink(link)) {
        toast.error('Unsupported session share link');
        navigate('/sessions');
        return;
      }

      if (nostrImportInFlight.current === link) {
        window.electron.logInfo('Skipping duplicate Nostr deep link import');
        return;
      }
      nostrImportInFlight.current = link;

      try {
        await importNostrSessionFromDeepLink(link);
        navigate('/sessions');
      } catch (error) {
        console.error('Unexpected error opening Nostr session share:', error);
        trackErrorWithContext(error, {
          component: 'AppInner',
          action: 'open_nostr_session_share',
          recoverable: true,
        });
        toast.error(`Failed to import Nostr session: ${errorMessage(error, 'Unknown error')}`);
        navigate('/sessions');
      } finally {
        if (nostrImportInFlight.current === link) {
          nostrImportInFlight.current = null;
        }
      }
    };
    window.electron.on('open-shared-session', handleOpenSharedSession);
    return () => {
      window.electron.off('open-shared-session', handleOpenSharedSession);
    };
  }, [navigate]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isMac = window.electron.platform === 'darwin';
      if ((isMac ? event.metaKey : event.ctrlKey) && event.key === 'n') {
        event.preventDefault();
        try {
          window.electron.createChatWindow();
        } catch (error) {
          console.error('Error creating new window:', error);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  // Prevent default drag and drop behavior globally to avoid opening files in new windows
  // but allow our React components to handle drops in designated areas
  useEffect(() => {
    const preventDefaults = (e: globalThis.DragEvent) => {
      // Only prevent default if we're not over a designated drop zone
      const target = e.target as HTMLElement;
      const isOverDropZone = target.closest('[data-drop-zone="true"]') !== null;

      if (!isOverDropZone) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const handleDragOver = (e: globalThis.DragEvent) => {
      // Always prevent default for dragover to allow dropping
      e.preventDefault();
      e.stopPropagation();
    };

    const handleDrop = (e: globalThis.DragEvent) => {
      // Only prevent default if we're not over a designated drop zone
      const target = e.target as HTMLElement;
      const isOverDropZone = target.closest('[data-drop-zone="true"]') !== null;

      if (!isOverDropZone) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    // Add event listeners to document to catch drag events
    document.addEventListener('dragenter', preventDefaults, false);
    document.addEventListener('dragleave', preventDefaults, false);
    document.addEventListener('dragover', handleDragOver, false);
    document.addEventListener('drop', handleDrop, false);

    return () => {
      document.removeEventListener('dragenter', preventDefaults, false);
      document.removeEventListener('dragleave', preventDefaults, false);
      document.removeEventListener('dragover', handleDragOver, false);
      document.removeEventListener('drop', handleDrop, false);
    };
  }, []);

  useEffect(() => {
    const handleFatalError = (_event: IpcRendererEvent, ...args: unknown[]) => {
      const errorMessage = args[0] as string;
      console.error('Encountered a fatal error:', errorMessage);
      setFatalError(errorMessage);
    };
    window.electron.on('fatal-error', handleFatalError);
    return () => {
      window.electron.off('fatal-error', handleFatalError);
    };
  }, []);

  useEffect(() => {
    const handleSetView = (_event: IpcRendererEvent, ...args: unknown[]) => {
      const newView = args[0] as View;
      const section = args[1] as string | undefined;

      if (section && newView === 'settings') {
        navigate(
          `${resolveCodeProEntryPath('/settings', codeProUnifiedMode)}?section=${encodeURIComponent(section)}`
        );
      } else {
        navigate(resolveCodeProEntryPath(`/${newView}`, codeProUnifiedMode));
      }
    };

    window.electron.on('set-view', handleSetView);
    return () => window.electron.off('set-view', handleSetView);
  }, [codeProUnifiedMode, navigate]);

  useEffect(() => {
    const handleNewChat = (_event: IpcRendererEvent, ..._args: unknown[]) => {
      navigate(resolveCodeProEntryPath('/', codeProUnifiedMode));
    };

    window.electron.on('new-chat', handleNewChat);
    return () => window.electron.off('new-chat', handleNewChat);
  }, [codeProUnifiedMode, navigate]);

  useEffect(() => {
    const handleFocusInput = (_event: IpcRendererEvent, ..._args: unknown[]) => {
      const inputField = document.querySelector('input[type="text"], textarea') as HTMLInputElement;
      if (inputField) {
        inputField.focus();
      }
    };
    window.electron.on('focus-input', handleFocusInput);
    return () => {
      window.electron.off('focus-input', handleFocusInput);
    };
  }, []);

  // Handle initial message from launcher
  const isProcessingRef = useRef(false);

  useEffect(() => {
    const handleSetInitialMessage = async (_event: IpcRendererEvent, ...args: unknown[]) => {
      const initialMessage = args[0] as string;
      const options = (args[1] as { noAutoSubmit?: boolean } | undefined) || {};

      if (initialMessage && !isProcessingRef.current) {
        isProcessingRef.current = true;
        navigate(resolveCodeProEntryPath('/pair', codeProUnifiedMode), {
          state: {
            initialMessage: { msg: initialMessage, images: [] },
            noAutoSubmit: options.noAutoSubmit,
          },
        });
        setTimeout(() => {
          isProcessingRef.current = false;
        }, 1000);
      }
    };
    window.electron.on('set-initial-message', handleSetInitialMessage);
    return () => {
      window.electron.off('set-initial-message', handleSetInitialMessage);
    };
  }, [codeProUnifiedMode, navigate]);

  // Register platform event handlers for app lifecycle management
  useEffect(() => {
    return registerPlatformEventHandlers();
  }, []);

  if (fatalError) {
    return <ErrorUI error={errorMessage(fatalError)} />;
  }

  return (
    <>
      <PageViewTracker />
      <ToastContainer
        aria-label={intl.formatMessage(i18n.toastNotifications)}
        toastClassName={() =>
          `relative min-h-16 mb-4 p-2 rounded-lg
               flex justify-between overflow-hidden cursor-pointer
               text-text-inverse bg-background-inverse
              `
        }
        style={{ width: '450px' }}
        className="mt-6"
        position="top-right"
        autoClose={3000}
        closeOnClick
        pauseOnHover
      />
      <ExtensionInstallModal addExtension={addExtension} setView={setView} />
      <RecipeParamsModalContainer />
      <div className="relative w-screen h-screen overflow-hidden bg-background-secondary flex flex-col">
        <div className="titlebar-drag-region" />
        <div style={{ position: 'relative', width: '100%', height: '100%' }}>
          <CodeProRouteGuard unifiedMode={codeProUnifiedMode}>
            <Routes location={settingsBackgroundLocation ?? location}>
              <Route path="launcher" element={<LauncherView />} />
              <Route path="configure-providers" element={<ConfigureProvidersRoute />} />
              <Route path="codepro/configure-providers" element={<ConfigureProvidersRoute />} />
              <Route path="standalone-app" element={<StandaloneAppView />} />
              <Route
                path="/"
                element={
                  <OnboardingGuard
                    requireModel={!isSettingsRoute}
                    onConfigure={() =>
                      navigate(
                        withWorkspaceMode('/settings', getWorkspaceModeFromPath(location.pathname)),
                        { state: { section: 'models' } }
                      )
                    }
                  >
                    <ChatProvider chat={chat} setChat={setChat} contextKey="hub">
                      <AppLayout activeSessions={activeSessions} />
                    </ChatProvider>
                  </OnboardingGuard>
                }
              >
                <Route index element={<HubRouteWrapper />} />
                <Route path="codepro" element={<CodeProHub />} />
                <Route
                  path="pair"
                  element={
                    <PairRouteWrapper
                      activeSessions={activeSessions}
                      setActiveSessions={setActiveSessions}
                    />
                  }
                />
                <Route
                  path="codepro/pair"
                  element={
                    <PairRouteWrapper
                      activeSessions={activeSessions}
                      setActiveSessions={setActiveSessions}
                    />
                  }
                />
                <Route path="settings" element={<SettingsRoute />} />
                <Route path="codepro/settings" element={<SettingsRoute />} />
                <Route path="sessions" element={<SessionsRoute />} />
                <Route path="codepro/sessions" element={<SessionsRoute />} />
                <Route path="schedules" element={<SchedulesRoute />} />
                <Route path="codepro/schedules" element={<SchedulesRoute />} />
                <Route path="recipes" element={<RecipesRoute />} />
                <Route path="codepro/recipes" element={<RecipesRoute />} />
                <Route path="toolbox" element={<ToolboxView />} />
                <Route path="codepro/toolbox" element={<ToolboxView />} />
                <Route path="skills" element={<SkillsView />} />
                <Route path="codepro/skills" element={<SkillsView />} />
                <Route path="apps" element={<LegacyToolboxRoute />} />
                <Route path="codepro/apps" element={<LegacyToolboxRoute />} />
                <Route path="extensions" element={<LegacyToolboxRoute />} />
                <Route path="codepro/extensions" element={<LegacyToolboxRoute />} />
                <Route path="permission" element={<PermissionRoute />} />
                <Route path="codepro/permission" element={<PermissionRoute />} />
              </Route>
            </Routes>
            {settingsBackgroundLocation && <SettingsRoute />}
          </CodeProRouteGuard>
        </div>
      </div>
    </>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <FeaturesProvider>
        <ModelAndProviderProvider>
          <HashRouter>
            <AppInner />
          </HashRouter>
          <AnnouncementModal />
          <TelemetryConsentPrompt />
        </ModelAndProviderProvider>
      </FeaturesProvider>
    </ThemeProvider>
  );
}
