import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, type RenderOptions, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ModelsBottomBar from './ModelsBottomBar';
import { IntlTestWrapper } from '../../../../i18n/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { readCodeProModelRouting } from '../../../../acp/codeproModelRouting';

const renderWithIntl = (ui: React.ReactElement, options?: RenderOptions & { route?: string }) => {
  const route = options?.route ?? '/pair';
  return render(ui, {
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={[route]}>
        <IntlTestWrapper>{children}</IntlTestWrapper>
      </MemoryRouter>
    ),
    ...options,
  });
};

const createDropdownRef = (): React.RefObject<HTMLDivElement> =>
  ({ current: document.createElement('div') }) as React.RefObject<HTMLDivElement>;

let mockCurrentModel: string | null = 'config-model';
let mockCurrentProvider: string | null = 'config-provider';
const mockGetProviders = vi.fn();
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual('react-router-dom')),
  useNavigate: () => mockNavigate,
}));
const mockOnModelChanged = vi.fn();

vi.mock('../../../ModelAndProviderContext', () => ({
  useModelAndProvider: () => ({
    currentModel: mockCurrentModel,
    currentProvider: mockCurrentProvider,
  }),
}));

vi.mock('../../../ConfigContext', () => ({
  useConfig: () => ({
    getProviders: mockGetProviders,
  }),
}));

vi.mock('../modelInterface', () => ({
  getProviderMetadata: vi.fn().mockResolvedValue({ display_name: 'Config Provider' }),
}));

vi.mock('../predefinedModelsUtils', () => ({
  getModelDisplayName: (model: string) => `Display ${model}`,
}));

vi.mock('../../../../acp/codeproModelRouting', () => ({
  readCodeProModelRouting: vi.fn(),
}));

vi.mock('../../../bottom_menu/BottomMenuAlertPopover', () => ({
  default: () => null,
}));

vi.mock('../../../ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children, ...props }: React.ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
  }) => <button onClick={onSelect}>{children}</button>,
}));

vi.mock('../../localInference/ModelSettingsPanel', () => ({
  ModelSettingsPanel: () => null,
}));

vi.mock('../../../ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../subcomponents/SwitchModelModal', () => ({
  SwitchModelModal: ({
    sessionId,
    applyToAllAgents,
  }: {
    sessionId: string | null;
    applyToAllAgents?: boolean;
  }) => (
    <div
      data-testid="switch-model-modal"
      data-apply-to-all-agents={String(Boolean(applyToAllAgents))}
    >
      {sessionId}
    </div>
  ),
}));

vi.mock('../../../codepro/CodeProModelModal', () => ({
  CodeProModelModal: ({
    onConfigureProvider,
    currentDefault,
  }: {
    onConfigureProvider?: () => void;
    currentDefault?: { provider: string; model: string };
  }) => (
    <div
      data-testid="codepro-model-modal"
      data-current-default={`${currentDefault?.provider}/${currentDefault?.model}`}
    >
      <button onClick={onConfigureProvider}>Use another provider…</button>
    </div>
  ),
}));

describe('ModelsBottomBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCurrentModel = 'config-model';
    mockCurrentProvider = 'config-provider';
    mockGetProviders.mockResolvedValue([]);
    vi.mocked(readCodeProModelRouting).mockResolvedValue(null);
  });

  it('shows a loading placeholder while the active session model is still loading', async () => {
    renderWithIntl(
      <ModelsBottomBar
        sessionId="session-123"
        dropdownRef={createDropdownRef()}
        setView={vi.fn()}
        onModelChanged={mockOnModelChanged}
        sessionLoaded={false}
      />
    );

    expect(screen.getByTestId('model-loading-state')).toHaveTextContent('Loading model...');
  });

  it('shows the active session model once the session has loaded', async () => {
    renderWithIntl(
      <ModelsBottomBar
        sessionId="session-123"
        dropdownRef={createDropdownRef()}
        setView={vi.fn()}
        sessionModel="session-model"
        sessionProvider="session-provider"
        onModelChanged={mockOnModelChanged}
        sessionLoaded={true}
      />
    );

    expect(screen.getByText('session-model')).toBeInTheDocument();
    expect(screen.queryByTestId('model-loading-state')).not.toBeInTheDocument();
  });

  it('shows the configured model when there is no active session', async () => {
    renderWithIntl(
      <ModelsBottomBar
        sessionId={null}
        dropdownRef={createDropdownRef()}
        setView={vi.fn()}
        onModelChanged={mockOnModelChanged}
      />
    );

    expect(screen.getByText('config-model')).toBeInTheDocument();
    expect(screen.queryByTestId('model-loading-state')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select or change model' })).toHaveAttribute(
      'title',
      'Select or change model'
    );
  });

  it('exposes the local model settings as a named modal with a named close button', async () => {
    const user = userEvent.setup();
    mockCurrentProvider = 'local';

    renderWithIntl(
      <ModelsBottomBar
        sessionId={null}
        dropdownRef={createDropdownRef()}
        setView={vi.fn()}
        onModelChanged={mockOnModelChanged}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Local Model Settings' }));

    expect(screen.getByRole('dialog', { name: /Local Model Settings/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close local model settings' })).toHaveAttribute(
      'title',
      'Close local model settings'
    );
  });

  it('shows one authoritative current model and the follow-current state in CodePro mode', async () => {
    renderWithIntl(
      <ModelsBottomBar
        sessionId="session-123"
        dropdownRef={createDropdownRef()}
        setView={vi.fn()}
        onModelChanged={mockOnModelChanged}
        sessionLoaded
      />,
      { route: '/codepro/pair' }
    );

    expect(screen.getByText('config-model')).toBeInTheDocument();
    expect(
      await screen.findByText('Subagents use their template model settings')
    ).toBeInTheDocument();
    expect(screen.queryByText('Agent model combination')).not.toBeInTheDocument();
  });

  it('labels explicit advanced routing without replacing the current model', async () => {
    vi.mocked(readCodeProModelRouting).mockResolvedValue({
      version: 2,
      advancedRoutingEnabled: true,
      routes: [],
      visionRoute: { enabled: true, mode: 'auto' },
      maxParallelCoders: 1,
    });
    renderWithIntl(
      <ModelsBottomBar
        sessionId="session-123"
        dropdownRef={createDropdownRef()}
        setView={vi.fn()}
        sessionModel="session-model"
        sessionProvider="session-provider"
        onModelChanged={mockOnModelChanged}
        sessionLoaded
      />,
      { route: '/codepro/pair' }
    );

    expect(screen.getByText('session-model')).toBeInTheDocument();
    expect(
      await screen.findByText('Subagents use their template model settings')
    ).toBeInTheDocument();
  });

  it('lets a CodePro session switch its current model independently of role routing', async () => {
    const user = userEvent.setup();

    renderWithIntl(
      <ModelsBottomBar
        sessionId="session-123"
        dropdownRef={createDropdownRef()}
        setView={vi.fn()}
        sessionModel="session-model"
        sessionProvider="session-provider"
        onModelChanged={mockOnModelChanged}
        sessionLoaded
      />,
      { route: '/codepro/pair' }
    );

    await user.click(screen.getByRole('button', { name: 'Change Model' }));

    expect(screen.getByTestId('switch-model-modal')).toHaveTextContent('session-123');
    expect(screen.getByTestId('switch-model-modal')).toHaveAttribute(
      'data-apply-to-all-agents',
      'true'
    );
    expect(screen.queryByTestId('codepro-model-modal')).not.toBeInTheDocument();
  });

  it('opens provider settings when agent configuration asks to use another provider', async () => {
    const user = userEvent.setup();
    const setView = vi.fn();

    renderWithIntl(
      <ModelsBottomBar
        sessionId="session-123"
        dropdownRef={createDropdownRef()}
        setView={setView}
        onModelChanged={mockOnModelChanged}
        sessionLoaded
      />,
      { route: '/codepro/pair' }
    );

    await user.click(screen.getByRole('button', { name: 'Configure agent models' }));
    expect(mockNavigate).toHaveBeenCalledWith('/codepro/settings', {
      state: { section: 'models' },
    });
    expect(screen.queryByTestId('codepro-model-modal')).not.toBeInTheDocument();
  });
});
