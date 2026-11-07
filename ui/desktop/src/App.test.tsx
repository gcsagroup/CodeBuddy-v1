vi.mock('./components/Layout/WindowMenuBar', () => ({ WindowMenuBar: () => null }));
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { screen, render, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AppInner, PairRouteWrapper, resolveSessionInitialMessage } from './App';
import { IntlTestWrapper } from './i18n/test-utils';
import { FeaturesProvider } from './contexts/FeaturesContext';
import { reconnectAcpAfterSystemResume } from './acp/acpConnection';
import { acpReadDefaults } from './acp/providers';
import { createSession } from './sessions';

const mainConversation = vi.hoisted(() => ({
  getMainConversation: vi.fn(async () => 'global-main'),
  deliverMainConversationMessage: vi.fn(async () => {}),
}));
vi.mock('./pets/mainConversation', () => mainConversation);

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

// Set up globals for jsdom
Object.defineProperty(window, 'location', {
  value: {
    hash: '',
    search: '',
    href: 'http://localhost:3000',
    origin: 'http://localhost:3000',
    pathname: '/',
  },
  writable: true,
});

Object.defineProperty(window, 'history', {
  value: {
    replaceState: vi.fn(),
    state: null,
  },
  writable: true,
});

vi.mock('./utils/costDatabase', () => ({
  initializeCostDatabase: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./acp/sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./acp/sessions')>()),
  acpListSessions: vi.fn().mockResolvedValue({ sessions: [], nextCursor: null }),
  acpDeleteSession: vi.fn().mockResolvedValue(undefined),
  acpLoadSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./sessions', () => ({
  fetchSessionDetails: vi
    .fn()
    .mockResolvedValue({ sessionId: 'test', messages: [], metadata: { description: '' } }),
  generateSessionId: vi.fn(),
  createSession: vi.fn(),
}));

vi.mock('./acp/capabilities', () => ({
  getAcpFeatureCapabilities: vi.fn().mockResolvedValue({ localInference: true }),
}));

vi.mock('./acp/acpConnection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./acp/acpConnection')>()),
  reconnectAcpAfterSystemResume: vi.fn(),
}));

// Mock the ACP providers module used by OnboardingGuard so it doesn't try to
// open a real ACP client connection during tests. Returning null defaults
// keeps the app in the "brand new" (no provider configured) onboarding state.
vi.mock('./acp/providers', () => ({
  acpReadDefaults: vi.fn().mockResolvedValue({ providerId: null, modelId: null }),
  acpSaveDefaults: vi.fn().mockResolvedValue(undefined),
  acpListProviderDetails: vi.fn().mockResolvedValue([]),
  acpDiscoverCustomProviderModels: vi.fn().mockResolvedValue([]),
  acpCreateCustomProviderFromRequest: vi.fn(),
}));

// Mock the ConfigContext module
vi.mock('./components/ConfigContext', () => ({
  useConfig: () => ({
    read: vi.fn().mockResolvedValue(null),
    update: vi.fn(),
    getExtensions: vi.fn().mockReturnValue([]),
    addExtension: vi.fn(),
    updateExtension: vi.fn(),
    createProviderDefaults: vi.fn(),
  }),
  ConfigProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock other components to simplify testing
vi.mock('./components/ErrorBoundary', () => ({
  ErrorUI: ({ error }: { error: Error }) => <div>Error: {error.message}</div>,
}));

vi.mock('./components/ModelAndProviderContext', () => ({
  ModelAndProviderProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useModelAndProvider: () => ({
    provider: null,
    model: null,
    getCurrentModelAndProvider: vi.fn(),
    getFallbackModelAndProvider: vi.fn().mockResolvedValue({ provider: '', model: '' }),
    refreshCurrentModelAndProvider: vi.fn().mockResolvedValue(undefined),
    setCurrentModelAndProvider: vi.fn(),
  }),
}));

vi.mock('./contexts/ChatContext', () => ({
  ChatProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useChatContext: () => ({
    chat: {
      id: 'test-id',
      name: 'Test Chat',
      messages: [],
      recipe: null,
    },
    setChat: vi.fn(),
    setPairChat: vi.fn(), // Keep this from HEAD
    resetChat: vi.fn(),
    hasActiveSession: false,
    setRecipe: vi.fn(),
    clearRecipe: vi.fn(),
    contextKey: 'hub',
  }),
  DEFAULT_CHAT_TITLE: 'New Chat', // Keep this from HEAD
}));

vi.mock('./components/ui/ConfirmationModal', () => ({
  ConfirmationModal: () => null,
}));

vi.mock('react-toastify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-toastify')>()),
  ToastContainer: () => null,
}));

vi.mock('./components/GoosehintsModal', () => ({
  GoosehintsModal: () => null,
}));

vi.mock('./components/AnnouncementModal', () => ({
  default: () => null,
}));

vi.mock('./components/codepro/CodeProHub', () => ({
  CodeProHub: ({
    launchIntent,
  }: {
    launchIntent?: {
      initialMessage?: { msg: string; images: Array<{ data: string; mimeType: string }> };
      recipeDeeplink?: string;
      recipeId?: string;
      noAutoSubmit?: boolean;
    };
  }) => (
    <div
      data-testid="codepro-hub-launch-intent"
      data-launch-intent={JSON.stringify(launchIntent)}
    />
  ),
}));

// Create mocks that we can track and configure per test
const mockNavigate = vi.fn();
const mockSearchParams = new URLSearchParams();
const mockSetSearchParams = vi.fn();
let mockLocationState: Record<string, unknown> | null = null;
let mockLocationPath = '/codepro';

// Mock react-router-dom to avoid HashRouter issues in tests
vi.mock('react-router-dom', () => ({
  HashRouter: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Routes: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Route: ({ element }: { element: React.ReactNode }) => element,
  Navigate: () => null,
  useNavigate: () => mockNavigate,
  useLocation: () => ({
    state: mockLocationState,
    pathname: mockLocationPath,
    search: '',
    hash: '',
  }),
  useSearchParams: () => [mockSearchParams, mockSetSearchParams],
  Outlet: () => null,
}));

// Mock electron API
const mockElectron = {
  petSignal: vi.fn(),
  getConfig: vi.fn().mockReturnValue({
    GOOSE_ALLOWLIST_WARNING: false,
    GOOSE_WORKING_DIR: '/test/dir',
  }),
  logInfo: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  reactReady: vi.fn(),
  getAllowedExtensions: vi.fn().mockResolvedValue([]),
  platform: 'darwin',
  getIsFullScreen: vi.fn().mockResolvedValue(false),
  createChatWindow: vi.fn(),
  directoryChooser: vi.fn(),
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
};

// Mock appConfig
const mockAppConfig = {
  get: vi.fn((key: string): string | null => {
    if (key === 'GOOSE_WORKING_DIR') return '/test/dir';
    return null;
  }),
};

// Attach mocks to window
(window as any).electron = mockElectron;
(window as any).appConfig = mockAppConfig;

// Mock matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // deprecated
    removeListener: vi.fn(), // deprecated
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

function AppInnerTestWrapper({ children }: { children: React.ReactNode }) {
  return (
    <IntlTestWrapper>
      <FeaturesProvider>{children}</FeaturesProvider>
    </IntlTestWrapper>
  );
}

describe('App Component - Brand New State', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockClear();
    mockSetSearchParams.mockClear();
    mockLocationState = null;
    mockLocationPath = '/codepro';
    mockAppConfig.get.mockImplementation((key: string): string | null => {
      if (key === 'GOOSE_WORKING_DIR') return '/test/dir';
      return null;
    });

    // Reset search params
    mockSearchParams.forEach((_, key) => {
      mockSearchParams.delete(key);
    });

    window.location.hash = '';
    window.location.search = '';
    window.location.pathname = '/';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should stay on the canonical CodePro entry when app is brand new', async () => {
    // Mock no provider configured
    mockElectron.getConfig.mockReturnValue({
      GOOSE_DEFAULT_PROVIDER: null,
      GOOSE_DEFAULT_MODEL: null,
      GOOSE_ALLOWLIST_WARNING: false,
    });

    render(<AppInner />, { wrapper: AppInnerTestWrapper });

    // Wait for initialization
    await waitFor(() => {
      expect(mockElectron.reactReady).toHaveBeenCalled();
    });

    // The app should initialize without any navigation calls since we're already at "/codepro"
    // No navigate calls should be made when no provider is configured
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('opens Ctrl+N as an unbound fresh conversation', async () => {
    render(<AppInner />, { wrapper: AppInnerTestWrapper });

    await waitFor(() => expect(mockElectron.reactReady).toHaveBeenCalled());
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true }));

    expect(mockElectron.createChatWindow).toHaveBeenCalledWith();
  });

  it('keeps a fresh Pair route retryable when explicit workspace selection is cancelled', async () => {
    mockLocationState = { initialMessage: { msg: 'hello', images: [] } };
    mockLocationPath = '/pair';
    mockElectron.directoryChooser.mockResolvedValue({ canceled: true, filePaths: [] });

    render(<PairRouteWrapper activeSessions={[]} setActiveSessions={vi.fn()} />, {
      wrapper: AppInnerTestWrapper,
    });

    await waitFor(() => expect(mockElectron.directoryChooser).toHaveBeenCalledOnce());
    expect(createSession).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalledWith('/');
    expect(await screen.findByRole('button', { name: 'Choose folder' })).toBeInTheDocument();
  });

  it('routes an ordinary skill draft to the new-chat composer without creating a session or selecting a folder', async () => {
    mockLocationState = {
      initialMessage: { msg: '/comfyui ', images: [] },
      draftOnly: true,
      noAutoSubmit: true,
    };
    mockLocationPath = '/pair';
    render(<PairRouteWrapper activeSessions={[]} setActiveSessions={vi.fn()} />, {
      wrapper: AppInnerTestWrapper,
    });
    expect(await screen.findByTestId('codepro-hub-launch-intent')).toHaveAttribute(
      'data-launch-intent',
      JSON.stringify({ initialMessage: mockLocationState.initialMessage, draftOnly: true, noAutoSubmit: true })
    );
    expect(createSession).not.toHaveBeenCalled();
    expect(mockElectron.directoryChooser).not.toHaveBeenCalled();
    expect(mockSetSearchParams).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'project skill workspace',
      routeState: {
        initialMessage: { msg: '/project-skill ', images: [] },
        draftOnly: true,
        noAutoSubmit: true,
        workingDir: 'D:\\SkillProject',
      },
      recipeDeeplink: null,
      recipeId: null,
      resumeSessionId: null,
      expectedIntent: {
        initialMessage: { msg: '/project-skill ', images: [] },
        draftOnly: true,
        noAutoSubmit: true,
        workingDir: 'D:\\SkillProject',
      },
    },
    {
      label: 'initial-message only',
      routeState: {
        initialMessage: {
          msg: 'build from this design',
          images: [{ data: 'base64-image', mimeType: 'image/png' }],
        },
        noAutoSubmit: true,
      },
      recipeDeeplink: null,
      recipeId: null,
      resumeSessionId: null,
      expectedIntent: {
        initialMessage: {
          msg: 'build from this design',
          images: [{ data: 'base64-image', mimeType: 'image/png' }],
        },
        noAutoSubmit: true,
      },
    },
    {
      label: 'recipe deeplink only',
      routeState: null,
      recipeDeeplink: 'recipe://ledger',
      recipeId: null,
      resumeSessionId: null,
      expectedIntent: { recipeDeeplink: 'recipe://ledger' },
    },
    {
      label: 'recipe id only',
      routeState: null,
      recipeDeeplink: null,
      recipeId: 'recipe-1',
      resumeSessionId: null,
      expectedIntent: { recipeId: 'recipe-1' },
    },
    {
      label: 'route recipe deeplink over stale app config',
      routeState: { recipeDeeplink: 'recipe://route-ledger' },
      recipeDeeplink: 'recipe://stale-config',
      recipeId: 'stale-config-id',
      resumeSessionId: null,
      expectedIntent: { recipeDeeplink: 'recipe://route-ledger' },
    },
    {
      label: 'route recipe id over stale app config',
      routeState: { recipeId: 'route-recipe-1' },
      recipeDeeplink: 'recipe://stale-config',
      recipeId: 'stale-config-id',
      resumeSessionId: null,
      expectedIntent: { recipeId: 'route-recipe-1' },
    },
    {
      label: 'resume session with fresh inputs present',
      routeState: {
        initialMessage: { msg: 'do not relaunch', images: [] },
        recipeId: 'route-recipe-1',
      },
      recipeDeeplink: 'recipe://ledger',
      recipeId: 'recipe-1',
      resumeSessionId: 'resume-1',
      expectedIntent: null,
    },
    {
      label: 'directory draft without inheriting a previous recipe',
      routeState: {
        initialMessage: { msg: '', images: [] },
        draftOnly: true,
        noAutoSubmit: true,
        workingDir: 'D:/projects/new-project',
      },
      recipeDeeplink: 'recipe://previous-project',
      recipeId: 'previous-project-recipe',
      resumeSessionId: null,
      expectedIntent: {
        initialMessage: { msg: '', images: [] },
        draftOnly: true,
        noAutoSubmit: true,
        workingDir: 'D:/projects/new-project',
      },
    },
  ])(
    'routes CodePro Pair $label without creating an unbound session',
    async ({ routeState, recipeDeeplink, recipeId, resumeSessionId, expectedIntent }) => {
      mockLocationState = routeState;
      mockLocationPath = '/codepro/pair';
      if (resumeSessionId) mockSearchParams.set('resumeSessionId', resumeSessionId);
      mockAppConfig.get.mockImplementation((key: string): string | null => {
        if (key === 'recipeDeeplink') return recipeDeeplink;
        if (key === 'recipeId') return recipeId;
        if (key === 'GOOSE_WORKING_DIR') return '/host/process/cwd';
        return null;
      });

      render(<PairRouteWrapper activeSessions={[]} setActiveSessions={vi.fn()} />, {
        wrapper: AppInnerTestWrapper,
      });

      if (expectedIntent) {
        const hub = await screen.findByTestId('codepro-hub-launch-intent');
        expect(JSON.parse(hub.getAttribute('data-launch-intent') ?? '{}')).toEqual(expectedIntent);
      } else {
        expect(screen.queryByTestId('codepro-hub-launch-intent')).toBeNull();
      }
      expect(mockElectron.directoryChooser).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
      expect(mockSetSearchParams).not.toHaveBeenCalled();
    }
  );

  it('should handle deep links correctly when app is brand new', async () => {
    let resolveDefaults!: (defaults: { providerId: null; modelId: null }) => void;
    vi.mocked(acpReadDefaults).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDefaults = resolve;
      })
    );

    // Mock no provider configured
    mockElectron.getConfig.mockReturnValue({
      GOOSE_DEFAULT_PROVIDER: null,
      GOOSE_DEFAULT_MODEL: null,
      GOOSE_ALLOWLIST_WARNING: false,
    });

    // Set up search params to simulate view=settings deep link
    mockSearchParams.set('view', 'settings');

    render(<AppInner />, { wrapper: AppInnerTestWrapper });

    // Wait for initialization
    await waitFor(() => {
      expect(mockElectron.reactReady).toHaveBeenCalled();
    });

    resolveDefaults({ providerId: null, modelId: null });

    expect((await screen.findAllByTestId('provider-selection-heading')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Welcome to CodeBuddy/)).not.toBeInTheDocument();
  });

  it('should not redirect when provider is configured', async () => {
    // Mock provider configured
    mockElectron.getConfig.mockReturnValue({
      GOOSE_DEFAULT_PROVIDER: 'openai',
      GOOSE_DEFAULT_MODEL: 'gpt-4',
      GOOSE_ALLOWLIST_WARNING: false,
    });

    render(<AppInner />, { wrapper: AppInnerTestWrapper });

    // Wait for initialization
    await waitFor(() => {
      expect(mockElectron.reactReady).toHaveBeenCalled();
    });

    // Should not navigate anywhere since provider is configured and we're already at "/codepro"
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('should navigate home when the main process emits new-chat', async () => {
    mockElectron.getConfig.mockReturnValue({
      GOOSE_DEFAULT_PROVIDER: 'openai',
      GOOSE_DEFAULT_MODEL: 'gpt-4',
      GOOSE_ALLOWLIST_WARNING: false,
    });

    render(<AppInner />, { wrapper: AppInnerTestWrapper });

    await waitFor(() => {
      expect(mockElectron.reactReady).toHaveBeenCalled();
    });

    const newChatHandler = mockElectron.on.mock.calls.find(
      ([channel]) => channel === 'new-chat'
    )?.[1];
    expect(newChatHandler).toBeDefined();

    newChatHandler?.({} as any);

    expect(mockNavigate).toHaveBeenCalledWith('/codepro');
  });

  it('stages a menu-selected directory in the current window without creating a session', async () => {
    render(<AppInner />, { wrapper: AppInnerTestWrapper });
    await waitFor(() => expect(mockElectron.reactReady).toHaveBeenCalled());
    const handler = mockElectron.on.mock.calls.find(([channel]) => channel === 'new-chat')?.[1];
    handler?.({} as any, 'D:\\中文项目');
    expect(mockNavigate).toHaveBeenCalledWith('/codepro/pair', {
      state: { draftOnly: true, workingDir: 'D:\\中文项目', noAutoSubmit: true },
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('should route a settings section from the main process through CodePro', async () => {
    render(<AppInner />, { wrapper: AppInnerTestWrapper });

    await waitFor(() => {
      expect(mockElectron.reactReady).toHaveBeenCalled();
    });

    const setViewHandler = mockElectron.on.mock.calls.find(
      ([channel]) => channel === 'set-view'
    )?.[1];
    expect(setViewHandler).toBeDefined();

    setViewHandler?.({} as any, 'settings', 'models');

    expect(mockNavigate).toHaveBeenCalledWith('/codepro/settings?section=models', {
      state: { backgroundLocation: expect.objectContaining({ pathname: '/codepro' }) },
    });
  });

  it('retains the original chat background when the main process changes an open settings section', async () => {
    const backgroundLocation = {
      pathname: '/codepro/pair',
      search: '?resumeSessionId=chat-1',
      state: null,
      key: 'chat-1',
      hash: '',
    };
    mockLocationPath = '/codepro/settings';
    mockLocationState = { backgroundLocation };
    render(<AppInner />, { wrapper: AppInnerTestWrapper });
    await waitFor(() => expect(mockElectron.reactReady).toHaveBeenCalled());
    const handler = mockElectron.on.mock.calls.find(([channel]) => channel === 'set-view')?.[1];
    handler({}, 'settings', 'models');
    expect(mockNavigate).toHaveBeenCalledWith('/codepro/settings?section=models', {
      state: { backgroundLocation },
      replace: true,
    });
  });

  it.each(['/codepro', '/codepro/settings', '/pair'])(
    'opens the exact pet task through the router from %s and clears stale route state',
    async (pathname) => {
      mockLocationPath = pathname;
      mockLocationState = { initialMessage: { msg: 'Previous draft', images: [] } };
      render(<AppInner />, { wrapper: AppInnerTestWrapper });
      await waitFor(() => expect(mockElectron.reactReady).toHaveBeenCalled());
      const handler = mockElectron.on.mock.calls.find(
        ([channel]) => channel === 'pet-open-session'
      )?.[1];
      expect(handler).toBeDefined();
      mockNavigate.mockClear();
      handler({}, 'task/b');
      expect(mockNavigate).toHaveBeenCalledWith(
        `${pathname.startsWith('/codepro') ? '/codepro' : ''}/pair?resumeSessionId=task%2Fb`,
        { state: null }
      );
      mockNavigate.mockClear();
      handler({}, '');
      expect(mockNavigate).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, 'D:/CodeBuddy/pets/custom'])(
    'preserves an explicit creation workspace without inheriting a prior project (%s)',
    async (workingDir) => {
      render(<AppInner />, { wrapper: AppInnerTestWrapper });
      await waitFor(() => expect(mockElectron.reactReady).toHaveBeenCalled());
      const handler = mockElectron.on.mock.calls.find(
        ([channel]) => channel === 'set-initial-message'
      )?.[1];
      expect(handler).toBeDefined();
      await handler({}, 'Create my pet', { noAutoSubmit: true, workingDir });
      expect(mockNavigate).toHaveBeenCalledWith('/codepro/pair', {
        state: {
          initialMessage: { msg: 'Create my pet', images: [] },
          noAutoSubmit: true,
          ...(workingDir ? { workingDir } : {}),
        },
      });
    }
  );

  it('opens custom pet creation as an editable draft in the current window', async () => {
    render(<AppInner />, { wrapper: AppInnerTestWrapper });
    await waitFor(() => expect(mockElectron.reactReady).toHaveBeenCalled());
    const handler = mockElectron.on.mock.calls.find(
      ([channel]) => channel === 'pet-create-session'
    )?.[1];
    handler({}, { dir: 'D:/pets/custom', query: '宠物形象：\n名字：' });
    expect(mockNavigate).toHaveBeenCalledWith('/codepro/pair', {
      state: {
        draftOnly: true,
        workingDir: 'D:/pets/custom',
        initialMessage: { msg: '宠物形象：\n名字：', images: [] },
        noAutoSubmit: true,
      },
    });
  });

  it('opens successive directory drafts in the current renderer without creating sessions', async () => {
    render(<AppInner />, { wrapper: AppInnerTestWrapper });
    await waitFor(() => expect(mockElectron.reactReady).toHaveBeenCalled());
    const handler = mockElectron.on.mock.calls.find(
      ([channel]) => channel === 'set-initial-message'
    )?.[1];
    for (const workingDir of ['D:/projects/中文 project', 'D:/another-project']) {
      handler({}, '', { workingDir, draftOnly: true, noAutoSubmit: true });
      expect(mockNavigate).toHaveBeenLastCalledWith('/codepro/pair', {
        state: {
          initialMessage: { msg: '', images: [] },
          workingDir,
          draftOnly: true,
          noAutoSubmit: true,
        },
      });
    }
    expect(createSession).not.toHaveBeenCalled();
  });

  it('keeps image-only input when a new main window delivers its pending message', async () => {
    render(<AppInner />, { wrapper: AppInnerTestWrapper });
    await waitFor(() => expect(mockElectron.reactReady).toHaveBeenCalled());
    const handler = mockElectron.on.mock.calls.find(
      ([channel]) => channel === 'set-initial-message'
    )?.[1];
    const images = [{ mimeType: 'image/jpeg', data: 'eA==' }];
    await handler({}, '', { images, noAutoSubmit: false });
    expect(mockNavigate).toHaveBeenCalledWith('/codepro/pair', {
      state: { initialMessage: { msg: '', images }, noAutoSubmit: false },
    });
  });

  it('routes repeated pet messages to the persistent main conversation without inheriting a project', async () => {
    mockLocationState = { workingDir: 'D:/previous', draftOnly: true };
    render(<AppInner />, { wrapper: AppInnerTestWrapper });
    await waitFor(() => expect(mockElectron.reactReady).toHaveBeenCalled());
    const handler = mockElectron.on.mock.calls.find(
      ([channel]) => channel === 'pet-send-message'
    )?.[1];
    mockNavigate.mockClear();
    handler({}, { msg: ' 新任务🙂 ', images: [], deliveryId: 'pet-transfer' });
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/codepro/pair?resumeSessionId=global-main', { state: null }));
    expect(mainConversation.deliverMainConversationMessage).toHaveBeenCalledWith('global-main', { msg: '新任务🙂', images: [], messageId: 'pet-transfer' });
    handler({}, { msg: '', images: [], deliveryId: 'pet-picker', composerAction: 'agent' });
    await waitFor(() => expect(mainConversation.deliverMainConversationMessage).toHaveBeenCalledWith('global-main', { msg: '', images: [], messageId: 'pet-picker', composerAction: 'agent' }));

    mockNavigate.mockClear();
    handler({}, '  ');
    handler({}, 'x'.repeat(8001));
    expect(mockNavigate).not.toHaveBeenCalled();
    const image = { data: 'eA==', mimeType: 'image/png' };
    handler({}, { msg: '', images: [image] });
    await waitFor(() => expect(mainConversation.deliverMainConversationMessage).toHaveBeenCalledWith('global-main', { msg: '', images: [image] }));
  });

  it('should reconnect ACP when the main process emits system-resume', async () => {
    render(<AppInner />, { wrapper: AppInnerTestWrapper });

    await waitFor(() => {
      expect(mockElectron.reactReady).toHaveBeenCalled();
    });

    const systemResumeHandler = mockElectron.on.mock.calls.find(
      ([channel]) => channel === 'system-resume'
    )?.[1];
    expect(systemResumeHandler).toBeDefined();

    systemResumeHandler?.({} as any);

    expect(reconnectAcpAfterSystemResume).toHaveBeenCalledOnce();
  });

  it('should seed recipe sessions with the recipe prompt when no initial message is provided', () => {
    expect(
      resolveSessionInitialMessage(
        {
          recipe: {
            prompt: 'Write a release note for the latest change',
          },
        },
        undefined
      )
    ).toEqual({
      msg: 'Write a release note for the latest change',
      images: [],
    });
  });
});
