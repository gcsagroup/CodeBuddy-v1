import { getMainConversation, deliverMainConversationMessage } from './pets/mainConversation';
import { lazy, Suspense, useEffect, useState, useRef } from 'react';
import { WindowMenuBar } from './components/Layout/WindowMenuBar';
import { RuntimeUpdateNotice } from './components/RuntimeUpdateNotice';
import './styles/desktop-shell.css';
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
import { acpChatSessionController } from './acp/chatSessionController';

import { ChatType } from './types/chat';
import { UserInput } from './types/message';

interface PairRouteState {
  workingDir?: string;
  resumeSessionId?: string;
  initialMessage?: UserInput;
  noAutoSubmit?: boolean;
  draftOnly?: boolean;
  recipeDeeplink?: string;
  recipeId?: string;
}
import type { SettingsViewOptions } from './components/settings/SettingsView';
import { parsePetMessage, parsePetComposerAction } from './pets/petMessage';
import ProviderSettings from './components/settings/providers/ProviderSettingsPage';
import { AppLayout } from './components/Layout/AppLayout';
import { ChatProvider, DEFAULT_CHAT_TITLE } from './contexts/ChatContext';
import LauncherView from './components/LauncherView';

import 'react-toastify/dist/ReactToastify.css';
import './components/extension-toast.css';
import { useConfig } from './components/ConfigContext';
import { ModelAndProviderProvider } from './components/ModelAndProviderContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { FeaturesProvider } from './contexts/FeaturesContext';
import PermissionSettingsView from './components/settings/permission/PermissionSetting';

import StandaloneAppView from './components/apps/StandaloneAppView';
import {
  getWorkspaceModeFromPath,
  View,
  ViewOptions,
  withWorkspaceMode,
} from './utils/navigationUtils';
import { resolveCodeProEntryPath } from './codepro/unifiedMode';

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

const SettingsView = lazy(() => import('./components/settings/SettingsView'));
const SessionsView = lazy(() => import('./components/sessions/SessionsView'));
const SchedulesView = lazy(() => import('./components/schedule/NativeSchedulesView'));
const RecipesView = lazy(() => import('./components/recipes/RecipesView'));
const ToolboxView = lazy(() => import('./components/toolbox/ToolboxView'));
const SkillsView = lazy(() => import('./components/skills/SkillsView'));
const MediaLibrary = lazy(() =>
  import('./components/media-library/MediaLibrary').then(module => ({ default: module.MediaLibrary }))
);
const CustomAgents = lazy(() =>
  import('./components/custom-agents/CustomAgents').then(module => ({ default: module.CustomAgents }))
);

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
  const hasRouteRecipe =
    routeState.draftOnly ||
    recipeDeeplinkFromRoute !== undefined ||
    recipeIdFromRoute !== undefined;
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
    Boolean(initialMessage || recipeDeeplink || recipeId || routeState.draftOnly);

  // Create session if we have an initialMessage, recipeDeeplink, or recipeId but no sessionId
  useEffect(() => {
    if (hasFreshCodeProLaunchIntent || routeState.draftOnly) return;
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
    routeState.draftOnly,
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
        key={location.key}
        launchIntent={{
          initialMessage,
          draftOnly: routeState.draftOnly,
          recipeDeeplink,
          recipeId,
          noAutoSubmit,
          workingDir: launchWorkingDir,
        }}
      />
    );
  }

  if (routeState.draftOnly && !resumeSessionId) {
    return (
      <CodeProHub
        key={location.key}
        launchIntent={{ initialMessage, workingDir: launchWorkingDir, draftOnly: true, noAutoSubmit }}
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
          case 'custom-agents':
            navigate(withWorkspaceMode('/custom-agents', workspaceMode));
            break;
          case 'media-library':
            navigate(withWorkspaceMode('/media-library', workspaceMode));
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
    <div className="w-full h-full bg-background-primary">
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

  const nostrImportInFlight = useRef<string | null>(null);

  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    if (location.pathname !== '/codepro' || new URLSearchParams(location.search).get('startupHome') !== '1') return;
    let active = true;
    void window.electron.startupModelConfigured().then(configured => {
      if (active) navigate(configured ? '/codepro' : '/codepro/configure-providers', { replace: true });
    }).catch(error => console.error('Failed to determine startup route', error));
    return () => { active = false; };
  }, [location.pathname, location.search, navigate]);
  const setView = useNavigation();
  const isSettingsRoute =
    location.pathname === '/settings' || location.pathname === '/codepro/settings';
  const isCustomAgentsRoute =
    location.pathname === '/custom-agents' || location.pathname === '/codepro/custom-agents';
  const settingsBackgroundLocation = isSettingsRoute
    ? (location.state as ViewOptions | null)?.backgroundLocation
    : undefined;

  useEffect(() => {
    const openPetSession = (_event: IpcRendererEvent, sessionId: unknown) => {
      if (typeof sessionId !== 'string' || !sessionId.trim()) return;
      // Use the router so its visible route and history state follow the target chat together.
      const pairPath = withWorkspaceMode('/pair', getWorkspaceModeFromPath(location.pathname));
      navigate(`${pairPath}?resumeSessionId=${encodeURIComponent(sessionId)}`, { state: null });
    };
    window.electron.on('pet-open-session', openPetSession);
    const unsubscribeQuestion = window.electron.on('agent-question-notice', (_event, payload) => {
      const { sessionId, title, questionId } = payload as { sessionId: string; title: string; questionId: string };
      toast.info(
        <button type="button" className="text-left font-medium"
          onClick={() => void window.electron.desktopPet({ action: 'open-task', sessionId })}>
          {intl.formatMessage({ id: 'app.questionNotice', defaultMessage: '{title} · Reply to agent' }, { title })}
        </button>,
        { toastId: JSON.stringify([sessionId, questionId]), position: 'top-center', autoClose: 8000 }
      );
    });
    const pausePetSession = (event: IpcRendererEvent, sessionId: unknown) => {
      if (typeof sessionId !== 'string' || !sessionId.trim()) return;
      acpChatSessionController.stop(sessionId);
      openPetSession(event, sessionId);
    };
    window.electron.on('pet-pause-session', pausePetSession);
    const createPetSession = (_event: IpcRendererEvent, value: unknown) => {
      const request = value as { dir?: unknown; query?: unknown } | null;
      if (typeof request?.dir !== 'string' || typeof request.query !== 'string') return;
      navigate(withWorkspaceMode('/pair', getWorkspaceModeFromPath(location.pathname)), {
        state: {
          draftOnly: true,
          workingDir: request.dir,
          initialMessage: { msg: request.query, images: [] },
          noAutoSubmit: true,
        },
      });
    };
    window.electron.on('pet-create-session', createPetSession);
    const sendPetMessage = (_event: IpcRendererEvent, message: unknown) => {
      const deliveryId = (message as { deliveryId?: string } | null)?.deliveryId;
      void (async () => {
        const rawAction = (message as { composerAction?: unknown } | null)?.composerAction;
        const composerAction = rawAction === undefined ? undefined : parsePetComposerAction(rawAction);
        const input = parsePetMessage(message, !!composerAction);
        const sessionId = await getMainConversation();
        navigate(`/codepro/pair?resumeSessionId=${encodeURIComponent(sessionId)}`, { state: null });
        await deliverMainConversationMessage(sessionId, { ...input, ...(deliveryId ? { messageId: deliveryId } : {}), ...(composerAction ? { composerAction } : {}) });
        window.electron.petSignal('pet-message-result', { deliveryId });
      })().catch(error => {
        window.electron.petSignal('pet-message-result', { deliveryId, error: error instanceof Error ? error.message : '无法发送到主对话' });
        toast.error(error instanceof Error ? error.message : '无法发送到主对话');
      });
    };
    const unsubscribePetMessages = window.electron.on('pet-send-message', sendPetMessage);
    const unsubscribePetPermissions = window.electron.on('pet-resolve-permission', (_event, payload) => {
      const value = payload as { sessionId: string; permission: { requestId: string; token: string; action: import('./types/permissions').Permission }; deliveryId: string };
      void import('./acp/permissionRequests').then(({ resolvePetPermission }) => {
        const { requestId, token, action } = value.permission;
        const accepted = resolvePetPermission(value.sessionId, requestId, token, action);
        window.electron.petSignal('pet-message-result', { deliveryId: value.deliveryId, ...(accepted ? {} : { error: '审批请求已失效或已处理，请查看最新通知' }) });
      }).catch(() => window.electron.petSignal('pet-message-result', { deliveryId: value.deliveryId, error: '无法处理审批，请重试' }));
    });
    return () => {
      window.electron.off('pet-open-session', openPetSession);
      unsubscribeQuestion?.();
      window.electron.off('pet-pause-session', pausePetSession);
      window.electron.off('pet-create-session', createPetSession);
      if (unsubscribePetMessages) unsubscribePetMessages();
      else window.electron.off('pet-send-message', sendPetMessage);
      unsubscribePetPermissions?.();
    };
  }, [intl, location.pathname, navigate]);

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

      if (newView === 'settings') {
        const backgroundLocation = isSettingsRoute ? settingsBackgroundLocation : location;
        navigate(
          `${resolveCodeProEntryPath('/settings')}${section ? `?section=${encodeURIComponent(section)}` : ''}`,
          {
            ...(backgroundLocation ? { state: { backgroundLocation } } : {}),
            ...(isSettingsRoute ? { replace: true } : {}),
          }
        );
      } else {
        navigate(resolveCodeProEntryPath(`/${newView}`));
      }
    };

    return window.electron.on('set-view', handleSetView);
  }, [navigate, isSettingsRoute, settingsBackgroundLocation, location]);

  useEffect(() => {
    const handleNewChat = (_event: IpcRendererEvent, directory?: unknown) => {
      if (typeof directory === 'string' && directory.trim()) {
        navigate(resolveCodeProEntryPath('/pair'), {
          state: { draftOnly: true, workingDir: directory, noAutoSubmit: true },
        });
        return;
      }
      navigate(resolveCodeProEntryPath('/'));
    };

    window.electron.on('new-chat', handleNewChat);
    return () => window.electron.off('new-chat', handleNewChat);
  }, [navigate]);

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
      const options =
        (args[1] as
          | {
              noAutoSubmit?: boolean;
              draftOnly?: boolean;
              workingDir?: string;
              images?: UserInput['images'];
            }
          | undefined) || {};

      if (
        options.draftOnly &&
        typeof options.workingDir === 'string' &&
        options.workingDir.trim()
      ) {
        navigate(resolveCodeProEntryPath('/pair'), {
          state: {
            initialMessage: { msg: initialMessage, images: options.images ?? [] },
            workingDir: options.workingDir,
            draftOnly: true,
            noAutoSubmit: true,
          },
        });
        return;
      }

      if ((initialMessage || options.images?.length) && !isProcessingRef.current) {
        isProcessingRef.current = true;
        navigate(resolveCodeProEntryPath('/pair'), {
          state: {
            initialMessage: { msg: initialMessage, images: options.images ?? [] },
            noAutoSubmit: options.noAutoSubmit,
            ...(typeof options.workingDir === 'string' && options.workingDir.trim()
              ? { workingDir: options.workingDir }
              : {}),
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
  }, [navigate]);

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
        className="codebuddy-toasts"
        hideProgressBar
        position="top-right"
        autoClose={3000}
        closeOnClick
        pauseOnHover
      />
      <ExtensionInstallModal addExtension={addExtension} setView={setView} />
      <RecipeParamsModalContainer />
      <div data-platform={window.electron?.platform} className="desktop-shell relative w-screen h-screen overflow-hidden bg-background-secondary flex flex-col">
        {location.pathname !== '/launcher' && location.pathname !== '/standalone-app' && <WindowMenuBar />}
        {location.pathname !== '/launcher' && location.pathname !== '/standalone-app' && <RuntimeUpdateNotice />}
        <div className="relative w-full flex-1 min-h-0">
          <CodeProRouteGuard>
            <Routes location={settingsBackgroundLocation ?? location}>
              <Route path="launcher" element={<LauncherView />} />
              <Route path="configure-providers" element={<ConfigureProvidersRoute />} />
              <Route path="codepro/configure-providers" element={<ConfigureProvidersRoute />} />
              <Route path="standalone-app" element={<StandaloneAppView />} />
              <Route
                path="/"
                element={
                  <OnboardingGuard
                    requireModel={!isSettingsRoute && !isCustomAgentsRoute}
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
                <Route index element={<CodeProHub />} />
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
                <Route path="custom-agents" element={<CustomAgents />} />
                <Route path="codepro/custom-agents" element={<CustomAgents />} />
                <Route path="media-library" element={<MediaLibrary />} />
                <Route path="codepro/media-library" element={<MediaLibrary />} />
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
            {settingsBackgroundLocation && (
              <Suspense fallback={null}>
                <SettingsRoute />
              </Suspense>
            )}
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
