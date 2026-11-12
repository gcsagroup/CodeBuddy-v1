import { useState } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlProvider } from 'react-intl';
import { IntlTestWrapper } from '../../i18n/test-utils';
import zhCnMessages from '../../i18n/messages/zh-CN.json';
import { startCodeProSession } from '../../codepro/startCodeProSession';
import { createSession } from '../../sessions';
import type { UserInput } from '../../types/message';
import type { MessageSubmissionLifecycle } from '../../hooks/useChatSessionTypes';
import { ChatState } from '../../types/chatState';
import { getHostProcessWorkingDir } from '../../utils/workingDir';
import { AppEvents } from '../../constants/events';
import { CodeProHub } from './CodeProHub';
import { clearNewTaskDraft } from '../../utils/newTaskDraft';
import { readPreferences } from '../../acp/preferences';
import type { FixedExtensionEntry } from '../ConfigContext';

const configFixture = vi.hoisted(() => ({ extensions: [] as FixedExtensionEntry[] }));

const navigate = vi.fn();
let submittedInput: UserInput = { msg: '开发一个记账应用', images: [] };
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('../ChatInput', () => ({
  default: function MockChatInput({
    handleSubmit,
    initialValue,
    chatState,
    modelToolbarSlot,
    onNextChatExtensionDraftChange,
  }: {
    handleSubmit: (
      input: UserInput,
      lifecycle?: MessageSubmissionLifecycle
    ) => Promise<void> | void;
    initialValue: string;
    chatState: ChatState;
    onWorkingDirChange?: (path: string) => void;
    modelToolbarSlot?: React.ReactNode;
    onNextChatExtensionDraftChange?: (draft: { selectedNames: Set<string> }) => void;
  }) {
    const [input, setInput] = useState<UserInput>(() => ({
      ...submittedInput,
      msg: initialValue || submittedInput.msg,
      images: submittedInput.images,
    }));
    return (
      <>
        {modelToolbarSlot}
        <button
          onClick={() =>
            onNextChatExtensionDraftChange?.({ selectedNames: new Set(['selected-mcp']) })
          }
        >
          Choose MCP
        </button>
        <span data-testid="draft-message">{input.msg}</span>
        <span data-testid="draft-image-count">{input.images.length}</span>
        <span data-testid="composer-state">{chatState}</span>
        <button
          type="button"
          onClick={() => {
            void Promise.resolve(
              handleSubmit(input, {
                onAccepted: () => setInput({ msg: '', images: [] }),
                onRejectedBeforeAcceptance: () => {},
              })
            ).catch(() => {});
          }}
        >
          Submit development goal
        </button>
      </>
    );
  },
}));
vi.mock('../ChatInputCard', () => ({
  ChatInputCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../bottom_menu/DirSwitcher', () => ({
  DirSwitcher: ({ onWorkingDirChange }: { onWorkingDirChange: (path: string) => void }) => <>
    <button onClick={() => onWorkingDirChange('D:\\')}>Select root</button>
    <button onClick={() => onWorkingDirChange('D:\\SchoolSystem')}>Select project</button>
  </>,
}));
vi.mock('../ConfigContext', () => ({
  useConfig: () => ({
    extensionsList: configFixture.extensions,
  }),
}));
vi.mock('../../hooks/useNavigation', () => ({ useNavigation: () => vi.fn() }));
vi.mock('../../utils/workingDir', () => ({
  getHostProcessWorkingDir: vi.fn(() => 'C:\\host-cwd'),
}));
vi.mock('../../codepro/startCodeProSession', () => ({ startCodeProSession: vi.fn() }));
vi.mock('../../sessions', () => ({ createSession: vi.fn() }));
vi.mock('../../acp/preferences', () => ({ readPreferences: vi.fn(), savePreferences: vi.fn(async (values) => ({ revision: 2, values })) }));

const inspection = {
  requestedPath: 'E:\\CodeProCp01\\Ledger',
  normalizedPath: 'E:\\CodeProCp01\\Ledger',
  normalizedIdentity: 'e:\\codeprocp01\\ledger',
  canonicalPath: null,
  source: 'prompt' as const,
  state: 'missing' as const,
  isGitRepository: false,
  displayName: 'Ledger',
  suggestedProjectId: 'ledger-a1b2c3d4e5f6',
  error: null,
};

const session = {
  id: 'session-1',
  name: 'untitled',
  message_count: 0,
  created_at: '2026-08-08T00:00:00Z',
  updated_at: '2026-08-08T00:00:00Z',
  working_dir: inspection.normalizedPath,
  project_id: inspection.suggestedProjectId,
  extension_data: {},
};

describe('CodeProHub', () => {
  beforeEach(() => {
    clearNewTaskDraft('codepro');
    configFixture.extensions = [];
    vi.clearAllMocks();
    vi.mocked(readPreferences).mockResolvedValue({
      revision: 1,
      values: [{ key: 'gooseMode', value: 'workspace-write', isMutable: true }],
    });
    submittedInput = { msg: '开发一个记账应用', images: [] };
    window.electron.defaultCodeProWorkspacePath = vi
      .fn()
      .mockResolvedValue(inspection.normalizedPath);
    window.electron.directoryChooser = vi.fn().mockResolvedValue({
      canceled: false,
      filePaths: ['D:\\project'],
    });
    window.electron.listRecentDirs = vi.fn().mockResolvedValue([]);
    window.electron.inspectCodeProWorkspace = vi.fn().mockResolvedValue([inspection]);
    vi.mocked(startCodeProSession).mockResolvedValue({
      session,
      projectId: inspection.suggestedProjectId,
      confirmation: {
        workingDir: inspection.normalizedPath,
        normalizedIdentity: inspection.normalizedIdentity,
        created: true,
        displayName: inspection.displayName,
        suggestedProjectId: inspection.suggestedProjectId,
      },
    });
    vi.mocked(createSession).mockResolvedValue(session);
  });

  it('starts new tasks with the configured native permission preset', async () => {
    const user = userEvent.setup();
    render(<CodeProHub />, { wrapper: IntlTestWrapper });
    expect(await screen.findByText('Workspace write')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Submit development goal' }));
    await waitFor(() =>
      expect(startCodeProSession).toHaveBeenCalledWith(
        expect.objectContaining({ initialPermissionPreset: 'workspace-write' })
      )
    );
  });

  it('passes the chosen approval mode to the new task before its first prompt', async () => {
    const user = userEvent.setup();
    render(<CodeProHub />, { wrapper: IntlTestWrapper });
    await screen.findByText('Workspace write');
    await user.click(screen.getByRole('button', { name: 'How should actions be approved?' }));
    await user.click(screen.getByRole('radio', { name: /Read only/ }));
    await user.click(screen.getByRole('button', { name: 'Submit development goal' }));
    await waitFor(() =>
      expect(startCodeProSession).toHaveBeenCalledWith(
        expect.objectContaining({ initialPermissionPreset: 'read-only' })
      )
    );
  });

  it('loads a slash-selected extension into the first session without changing global defaults', async () => {
    configFixture.extensions = [
      { type: 'builtin', name: 'selected-mcp', description: '', enabled: false },
    ];
    const user = userEvent.setup();
    render(<CodeProHub />, { wrapper: IntlTestWrapper });
    await user.click(screen.getByText('Choose MCP'));
    await user.click(screen.getByText('Submit development goal'));
    await waitFor(() =>
      expect(startCodeProSession).toHaveBeenCalledWith(
        expect.objectContaining({
          allExtensions: [expect.objectContaining({ name: 'selected-mcp', enabled: true })],
        })
      )
    );
  });

  it('keeps a pet template on the new-task page until the user sends it', async () => {
    const user = userEvent.setup();
    render(
      <CodeProHub
        launchIntent={{
          draftOnly: true,
          workingDir: 'D:/pets/custom',
          initialMessage: { msg: '宠物形象：小熊猫', images: [] },
          noAutoSubmit: true,
        }}
      />,
      { wrapper: IntlTestWrapper }
    );
    expect(screen.getByTestId('draft-message')).toHaveTextContent('宠物形象：小熊猫');
    await act(async () => {});
    expect(startCodeProSession).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(window.electron.inspectCodeProWorkspace).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Submit development goal' }));
    await waitFor(() => expect(startCodeProSession).toHaveBeenCalledTimes(1));
  });

  it('renders product copy in the current language', () => {
    render(<CodeProHub />, { wrapper: IntlTestWrapper });

    expect(screen.getByRole('heading', { name: "I'm CodeBuddy. Let's work together." })).toBeVisible();
    expect(screen.getByText('Write and debug code')).toBeVisible();
    expect(screen.getByText('Organize documents and data')).toBeVisible();
    expect(screen.getByText('Plan, execute and check')).toBeVisible();
    expect(screen.queryByText('Automatic task breakdown')).not.toBeInTheDocument();
    expect(screen.queryByText('Multi-model collaboration')).not.toBeInTheDocument();
    expect(screen.queryByText('Edit in place with a complete activity trail')).not.toBeInTheDocument();
  });

  it('keeps the draft and blocks duplicate sends until session creation commits', async () => {
    const result = await vi.mocked(startCodeProSession).getMockImplementation()!(
      {} as Parameters<typeof startCodeProSession>[0]
    );
    vi.mocked(startCodeProSession).mockClear();
    let finish!: (value: typeof result) => void;
    vi.mocked(startCodeProSession).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    submittedInput = { msg: 'first message', images: [{ data: 'image', mimeType: 'image/png' }] };
    const user = userEvent.setup();
    render(<CodeProHub />, { wrapper: IntlTestWrapper });
    const submit = screen.getByRole('button', { name: 'Submit development goal' });
    await user.click(submit);
    await waitFor(() => expect(startCodeProSession).toHaveBeenCalledOnce());
    expect(submit).toBeDisabled();
    expect(screen.getByTestId('composer-state')).toHaveTextContent(ChatState.Idle);
    expect(screen.getByTestId('draft-message')).toHaveTextContent('first message');
    expect(screen.getByTestId('draft-image-count')).toHaveTextContent('1');
    await user.click(submit);
    expect(startCodeProSession).toHaveBeenCalledOnce();
    await act(async () => finish(result));
    await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(screen.getByTestId('draft-message')).toBeEmptyDOMElement();
    expect(screen.getByTestId('draft-image-count')).toHaveTextContent('0');
  });

  it('does not accept or clear the input while asynchronous directory inspection is pending', async () => {
    const user = userEvent.setup();
    let finishInspection!: (value: (typeof inspection)[]) => void;
    vi.mocked(window.electron.inspectCodeProWorkspace).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishInspection = resolve;
        })
    );
    render(<CodeProHub />, { wrapper: IntlTestWrapper });
    const submit = screen.getByRole('button', { name: 'Submit development goal' });
    await user.click(submit);
    expect(submit).toBeDisabled();
    expect(screen.getByTestId('composer-state')).toHaveTextContent(ChatState.Idle);
    expect(screen.getByTestId('draft-message')).toHaveTextContent(submittedInput.msg);
    await user.click(submit);
    expect(window.electron.inspectCodeProWorkspace).toHaveBeenCalledOnce();
    finishInspection([inspection]);
    await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(screen.getByTestId('draft-message')).toBeEmptyDOMElement();
  });

  it('starts the inspected project without a second workspace confirmation', async () => {
    const user = userEvent.setup();
    const sequence: string[] = [];
    const dispatch = vi.spyOn(window, 'dispatchEvent').mockImplementation((submitted) => {
      if (submitted.type === AppEvents.SESSION_CREATED) sequence.push('SESSION_CREATED');
      if (submitted.type === AppEvents.ADD_ACTIVE_SESSION) sequence.push('ADD_ACTIVE_SESSION');
      return true;
    });
    navigate.mockImplementation(() => sequence.push('navigate'));
    render(<CodeProHub />, { wrapper: IntlTestWrapper });

    await user.click(screen.getByRole('button', { name: 'Submit development goal' }));

    expect(window.electron.inspectCodeProWorkspace).toHaveBeenCalledWith({
      prompt: '',
      selectedWorkingDir: inspection.normalizedPath,
    });
    await waitFor(() => expect(startCodeProSession).toHaveBeenCalledOnce());
    expect(screen.queryByRole('heading', { name: 'Confirm project workspace' })).toBeNull();
    expect(startCodeProSession).toHaveBeenCalledWith({
      workspaceOrigin: 'default',
      initialPermissionPreset: 'workspace-write',
      candidate: inspection,
      initialMessage: { msg: '开发一个记账应用', images: [] },
      allExtensions: [],
    });
    expect(navigate).toHaveBeenCalledWith('/codepro/pair?resumeSessionId=session-1', {
      state: { initialMessage: { msg: '开发一个记账应用', images: [] } },
    });
    expect(
      dispatch.mock.calls.filter(([submitted]) => submitted.type === AppEvents.SESSION_CREATED)
    ).toHaveLength(1);
    expect(
      dispatch.mock.calls.filter(([submitted]) => submitted.type === AppEvents.ADD_ACTIVE_SESSION)
    ).toHaveLength(1);
    expect(navigate).toHaveBeenCalledOnce();
    expect(sequence).toEqual(['SESSION_CREATED', 'ADD_ACTIVE_SESSION', 'navigate']);
    dispatch.mockRestore();
  });

  it.each([
    { goalRequest: { action: 'create' as const, objective: 'Ship and test', maxGoalRounds: 20 } },
    { planMode: true },
  ])('preserves structured slash requests in the first project message: %j', async (request) => {
    submittedInput = { msg: 'Ship and test', images: [], ...request };
    render(<CodeProHub />, { wrapper: IntlTestWrapper });
    expect(screen.queryByRole('checkbox')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Submit development goal' }));
    await waitFor(() =>
      expect(startCodeProSession).toHaveBeenCalledWith(
        expect.objectContaining({
          initialMessage: submittedInput,
        })
      )
    );
  });

  it('rejects an occupied default workspace without starting or clearing the goal', async () => {
    vi.mocked(window.electron.inspectCodeProWorkspace).mockResolvedValue([
      { ...inspection, source: 'selected', state: 'non-empty-directory' },
    ]);
    const user = userEvent.setup();
    render(<CodeProHub />, { wrapper: IntlTestWrapper });
    await user.click(screen.getByRole('button', { name: 'Submit development goal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to inspect the project workspace.'
    );
    expect(startCodeProSession).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(screen.getByTestId('draft-message')).toHaveTextContent(submittedInput.msg);
  });

  it('honors an explicitly selected existing project without using host cwd or parsing the goal', async () => {
    const selected = {
      ...inspection,
      source: 'selected' as const,
      state: 'non-empty-directory' as const,
      normalizedPath: 'D:\\SchoolSystem',
    };
    vi.mocked(window.electron.inspectCodeProWorkspace).mockResolvedValue([selected]);
    submittedInput = { msg: 'inspect E:\\OtherProject', images: [] };
    const user = userEvent.setup();
    render(<CodeProHub />, { wrapper: IntlTestWrapper });
    await user.click(screen.getByRole('button', { name: 'Select project' }));
    await user.click(screen.getByRole('button', { name: 'Submit development goal' }));
    await waitFor(() => expect(startCodeProSession).toHaveBeenCalledOnce());
    expect(window.electron.defaultCodeProWorkspacePath).not.toHaveBeenCalled();
    expect(window.electron.inspectCodeProWorkspace).toHaveBeenCalledWith({
      prompt: '',
      selectedWorkingDir: 'D:\\SchoolSystem',
    });
    expect(startCodeProSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceOrigin: 'selected',
        candidate: selected,
        initialMessage: submittedInput,
      })
    );
    expect(getHostProcessWorkingDir).not.toHaveBeenCalled();
  });

  it('retries an occupied allocation using a fresh path and preserves the original goal', async () => {
    vi.mocked(window.electron.inspectCodeProWorkspace)
      .mockResolvedValueOnce([{ ...inspection, state: 'non-empty-directory' }])
      .mockResolvedValueOnce([inspection]);
    const user = userEvent.setup();
    render(<CodeProHub />, { wrapper: IntlTestWrapper });
    await user.click(screen.getByRole('button', { name: 'Submit development goal' }));
    await screen.findByRole('alert');
    expect(startCodeProSession).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Retry workspace setup' }));
    await waitFor(() => expect(startCodeProSession).toHaveBeenCalledOnce());
    expect(window.electron.defaultCodeProWorkspacePath).toHaveBeenCalledTimes(2);
    expect(startCodeProSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceOrigin: 'default', initialMessage: submittedInput })
    );
  });

  it('preserves the full launch intent while starting automatically', async () => {
    const initialMessage: UserInput = {
      msg: 'build from this design',
      images: [{ data: 'base64-image', mimeType: 'image/png' }],
    };
    render(
      <CodeProHub
        launchIntent={{
          initialMessage,
          recipeDeeplink: 'recipe://ledger',
          recipeId: 'recipe-1',
          noAutoSubmit: true,
        }}
      />,
      { wrapper: IntlTestWrapper }
    );

    await waitFor(() => expect(startCodeProSession).toHaveBeenCalledOnce());
    expect(startCodeProSession).toHaveBeenCalledWith({
      workspaceOrigin: 'default',
      initialPermissionPreset: 'workspace-write',
      candidate: inspection,
      initialMessage,
      allExtensions: [],
      recipeDeeplink: 'recipe://ledger',
      recipeId: 'recipe-1',
    });
    expect(navigate).toHaveBeenCalledWith('/codepro/pair?resumeSessionId=session-1', {
      state: { initialMessage, noAutoSubmit: true },
    });
  });

  it('honors a project skill launch directory without allocating a default workspace', async () => {
    const selected = {
      ...inspection,
      source: 'selected' as const,
      state: 'non-empty-directory' as const,
      normalizedPath: 'D:\\SkillProject',
    };
    vi.mocked(window.electron.inspectCodeProWorkspace).mockResolvedValue([selected]);
    render(
      <CodeProHub
        launchIntent={{
          initialMessage: { msg: '/demo ', images: [] },
          draftOnly: true,
          noAutoSubmit: true,
          workingDir: 'D:\\SkillProject',
        }}
      />,
      { wrapper: IntlTestWrapper }
    );
    await act(async () => {});
    expect(screen.getByTestId('draft-message')).toHaveTextContent('/demo');
    expect(startCodeProSession).not.toHaveBeenCalled();
    expect(window.electron.inspectCodeProWorkspace).not.toHaveBeenCalled();
    expect(window.electron.defaultCodeProWorkspacePath).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Submit development goal' }));
    await waitFor(() => expect(startCodeProSession).toHaveBeenCalledOnce());
    expect(window.electron.inspectCodeProWorkspace).toHaveBeenCalledWith({
      prompt: '',
      selectedWorkingDir: 'D:\\SkillProject',
    });
    expect(startCodeProSession).toHaveBeenCalledWith(
      expect.objectContaining({ candidate: selected })
    );
  });

  it('does not render a second confirmation for a selected root project', () => {
    render(
      <IntlProvider
        locale="zh-CN"
        messages={Object.fromEntries(
          Object.entries(zhCnMessages).map(([id, message]) => [id, message.defaultMessage])
        )}
      >
        <CodeProHub />
      </IntlProvider>
    );

    expect(screen.queryByRole('button', { name: '确认容器' })).toBeNull();
    expect(screen.queryByText('已确认根容器：D:\\')).toBeNull();
  });

  it('confirms a launch-intent drive root only as a container and preserves recipe options', async () => {
    vi.mocked(window.electron.directoryChooser).mockResolvedValue({
      canceled: false,
      filePaths: ['D:\\'],
    });
    const rootInspection = {
      ...inspection,
      requestedPath: 'D:\\',
      normalizedPath: 'D:\\',
      normalizedIdentity: 'd:\\',
      canonicalPath: 'D:\\',
      state: 'filesystem-root' as const,
      displayName: 'D:\\',
    };
    window.electron.inspectCodeProWorkspace = vi.fn().mockResolvedValue([rootInspection]);
    const user = userEvent.setup();
    const view = render(<CodeProHub />, { wrapper: IntlTestWrapper });
    await user.click(screen.getByRole('button', { name: 'Select root' }));
    view.rerender(
      <CodeProHub
        launchIntent={{
          initialMessage: submittedInput,
          recipeDeeplink: 'recipe://ledger',
          recipeId: 'recipe-1',
        }}
      />
    );

    await waitFor(() => expect(createSession).toHaveBeenCalledOnce());
    expect(createSession).toHaveBeenCalledWith('D:\\', {
      workspaceOrigin: 'selected',
      initialPermissionPreset: 'workspace-write',
      allExtensions: [],
      workspaceMode: 'codepro',
      workspaceBinding: 'root_container',
      rootContainerPath: 'D:\\',
      recipeDeeplink: 'recipe://ledger',
      recipeId: 'recipe-1',
    });
    expect(startCodeProSession).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/codepro/pair?resumeSessionId=session-1', {
      state: { initialMessage: { msg: '开发一个记账应用', images: [] } },
    });
  });

  it('keeps the full goal in the Hub and retries after workspace allocation fails', async () => {
    const user = userEvent.setup();
    submittedInput = {
      msg: '开发一个记账应用',
      images: [{ data: 'base64-image', mimeType: 'image/png' }],
    };
    vi.mocked(window.electron.defaultCodeProWorkspacePath)
      .mockRejectedValueOnce(new Error('Allocation failed at D:\\private'))
      .mockResolvedValueOnce(inspection.normalizedPath);
    render(<CodeProHub />, { wrapper: IntlTestWrapper });

    await user.click(screen.getByRole('button', { name: 'Submit development goal' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to inspect the project workspace.'
    );
    expect(screen.getByTestId('draft-message')).toHaveTextContent('开发一个记账应用');
    expect(screen.getByTestId('draft-image-count')).toHaveTextContent('1');
    expect(getHostProcessWorkingDir).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(startCodeProSession).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Submit development goal' }));

    expect(window.electron.inspectCodeProWorkspace).toHaveBeenCalledWith({
      prompt: '',
      selectedWorkingDir: 'E:\\CodeProCp01\\Ledger',
    });
    await waitFor(() => expect(startCodeProSession).toHaveBeenCalledOnce());
    expect(startCodeProSession).toHaveBeenCalledWith({
      workspaceOrigin: 'default',
      initialPermissionPreset: 'workspace-write',
      candidate: inspection,
      initialMessage: submittedInput,
      allExtensions: [],
    });
    expect(createSession).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/codepro/pair?resumeSessionId=session-1', {
      state: { initialMessage: submittedInput },
    });
  });

  it('keeps workspace allocation failures path-free and retryable without leaving the Hub', async () => {
    const user = userEvent.setup();
    vi.mocked(window.electron.defaultCodeProWorkspacePath)
      .mockRejectedValueOnce(new Error('Allocation failed at D:\\private'))
      .mockResolvedValueOnce(inspection.normalizedPath);
    render(<CodeProHub />, { wrapper: IntlTestWrapper });

    await user.click(screen.getByRole('button', { name: 'Submit development goal' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Unable to inspect the project workspace.');
    expect(alert).not.toHaveTextContent('secret');
    expect(createSession).not.toHaveBeenCalled();
    expect(startCodeProSession).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Submit development goal' }));

    expect(window.electron.defaultCodeProWorkspacePath).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(startCodeProSession).toHaveBeenCalledOnce());
  });

  it('consumes a launch intent once and retries with its full input after allocation failure', async () => {
    const user = userEvent.setup();
    const initialMessage: UserInput = {
      msg: 'build from this design',
      images: [{ data: 'base64-image', mimeType: 'image/png' }],
    };
    vi.mocked(window.electron.defaultCodeProWorkspacePath)
      .mockRejectedValueOnce(new Error('Allocation failed at D:\\private'))
      .mockResolvedValueOnce(inspection.normalizedPath);

    render(
      <CodeProHub
        launchIntent={{
          initialMessage,
          recipeDeeplink: 'recipe://ledger',
          recipeId: 'recipe-1',
          noAutoSubmit: true,
        }}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to inspect the project workspace.'
    );
    expect(createSession).not.toHaveBeenCalled();
    expect(startCodeProSession).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Retry workspace setup' }));
    await waitFor(() => expect(startCodeProSession).toHaveBeenCalledOnce());
    expect(startCodeProSession).toHaveBeenCalledWith({
      workspaceOrigin: 'default',
      initialPermissionPreset: 'workspace-write',
      candidate: inspection,
      initialMessage,
      allExtensions: [],
      recipeDeeplink: 'recipe://ledger',
      recipeId: 'recipe-1',
    });
    expect(window.electron.defaultCodeProWorkspacePath).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledWith('/codepro/pair?resumeSessionId=session-1', {
      state: { initialMessage, noAutoSubmit: true },
    });
  });

  it('derives a recipe-only launch message once from the created session recipe prompt', async () => {
    vi.mocked(window.electron.directoryChooser).mockResolvedValue({
      canceled: false,
      filePaths: ['E:\\CodeProCp01\\Ledger'],
    });
    vi.mocked(startCodeProSession).mockResolvedValue({
      session: {
        ...session,
        recipe: {
          title: 'Ledger recipe',
          description: 'Creates a ledger project',
          prompt: 'recipe-generated goal',
        },
      },
      projectId: inspection.suggestedProjectId,
      confirmation: {
        workingDir: inspection.normalizedPath,
        normalizedIdentity: inspection.normalizedIdentity,
        created: true,
        displayName: inspection.displayName,
        suggestedProjectId: inspection.suggestedProjectId,
      },
    });
    const dispatch = vi.spyOn(window, 'dispatchEvent');

    render(<CodeProHub launchIntent={{ recipeId: 'recipe-1' }} />, {
      wrapper: IntlTestWrapper,
    });

    await waitFor(() =>
      expect(window.electron.inspectCodeProWorkspace).toHaveBeenCalledWith({
        prompt: '',
        selectedWorkingDir: 'E:\\CodeProCp01\\Ledger',
      })
    );
    await waitFor(() => expect(startCodeProSession).toHaveBeenCalledOnce());

    const additions = dispatch.mock.calls.filter(
      ([submitted]) => submitted.type === AppEvents.ADD_ACTIVE_SESSION
    );
    expect(additions).toHaveLength(1);
    expect((additions[0][0] as CustomEvent).detail.initialMessage).toEqual({
      msg: 'recipe-generated goal',
      images: [],
    });
    expect(navigate).toHaveBeenCalledWith('/codepro/pair?resumeSessionId=session-1', {
      state: { initialMessage: { msg: 'recipe-generated goal', images: [] } },
    });
    dispatch.mockRestore();
  });

  it('does not invent an initial message when a recipe session has no prompt', async () => {
    vi.mocked(startCodeProSession).mockResolvedValue({
      session: {
        ...session,
        recipe: {
          title: 'Ledger recipe',
          description: 'Creates a ledger project',
          prompt: '   ',
        },
      },
      projectId: inspection.suggestedProjectId,
      confirmation: {
        workingDir: inspection.normalizedPath,
        normalizedIdentity: inspection.normalizedIdentity,
        created: true,
        displayName: inspection.displayName,
        suggestedProjectId: inspection.suggestedProjectId,
      },
    });
    const dispatch = vi.spyOn(window, 'dispatchEvent');

    render(<CodeProHub launchIntent={{ recipeDeeplink: 'recipe://ledger' }} />, {
      wrapper: IntlTestWrapper,
    });
    await waitFor(() => expect(startCodeProSession).toHaveBeenCalledOnce());

    const addition = dispatch.mock.calls.find(
      ([submitted]) => submitted.type === AppEvents.ADD_ACTIVE_SESSION
    )?.[0] as CustomEvent;
    expect(addition.detail).not.toHaveProperty('initialMessage');
    expect(navigate).toHaveBeenCalledWith('/codepro/pair?resumeSessionId=session-1', {
      state: {},
    });
    dispatch.mockRestore();
  });

  it('maps allowlisted structured workspace diagnostics to fixed path-free copy', async () => {
    const user = userEvent.setup();
    vi.mocked(startCodeProSession).mockRejectedValue(
      Object.assign(new Error('Invalid params'), {
        error: {
          message: 'Invalid params',
          data: {
            code: 'workspace_identity_unavailable',
            message: 'Unable to identify D:\\private\\project',
          },
        },
      })
    );
    render(<CodeProHub />, { wrapper: IntlTestWrapper });

    await user.click(screen.getByRole('button', { name: 'Submit development goal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The selected workspace could not be safely verified. Choose a supported local project folder and try again.'
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('Invalid params');
    expect(screen.getByRole('alert')).not.toHaveTextContent('private');
  });

  it('keeps unknown workspace inspection failures path-free', async () => {
    const user = userEvent.setup();
    vi.mocked(window.electron.inspectCodeProWorkspace).mockRejectedValue(
      new Error('inspection failed at D:\\private\\project')
    );
    render(<CodeProHub />, { wrapper: IntlTestWrapper });

    await user.click(screen.getByRole('button', { name: 'Submit development goal' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to inspect the project workspace.'
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('private');
  });

  it('keeps unknown root-container session failures path-free', async () => {
    vi.mocked(window.electron.directoryChooser).mockResolvedValue({
      canceled: false,
      filePaths: ['D:\\'],
    });
    window.electron.inspectCodeProWorkspace = vi.fn().mockResolvedValue([
      {
        ...inspection,
        requestedPath: 'D:\\',
        normalizedPath: 'D:\\',
        normalizedIdentity: 'd:\\',
        canonicalPath: 'D:\\',
        state: 'filesystem-root' as const,
        displayName: 'D:\\',
      },
    ]);
    vi.mocked(createSession).mockRejectedValue(
      new Error('root-container setup failed at D:\\private')
    );
    const user = userEvent.setup();
    render(<CodeProHub />, { wrapper: IntlTestWrapper });
    await user.click(screen.getByRole('button', { name: 'Select root' }));
    await user.click(screen.getByRole('button', { name: 'Submit development goal' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to start CodePro with the root container.'
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('private');
  });

  it('keeps unknown lease-backed session failures path-free', async () => {
    const user = userEvent.setup();
    vi.mocked(startCodeProSession).mockRejectedValue(
      new Error('lease-backed setup failed at D:\\private\\project')
    );
    render(<CodeProHub />, { wrapper: IntlTestWrapper });

    await user.click(screen.getByRole('button', { name: 'Submit development goal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to start CodePro in the selected workspace.'
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('private');
  });

  it('does not treat Object prototype keys as allowlisted structured diagnostics', async () => {
    const user = userEvent.setup();
    vi.mocked(startCodeProSession).mockRejectedValue({
      error: {
        data: {
          code: 'toString',
          message: 'lease-backed setup failed at D:\\private\\project',
        },
      },
    });
    render(<CodeProHub />, { wrapper: IntlTestWrapper });

    await user.click(screen.getByRole('button', { name: 'Submit development goal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to start CodePro in the selected workspace.'
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('private');
  });
});
