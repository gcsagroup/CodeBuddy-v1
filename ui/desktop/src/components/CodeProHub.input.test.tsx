import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { startCodeProSession } from '../codepro/startCodeProSession';
import { CodeProHub } from './codepro/CodeProHub';
import { clearNewTaskDraft, updateNewTaskDraft } from '../utils/newTaskDraft';

vi.mock('../acp/preferences', () => ({
  readPreferences: vi.fn(async () => ({ revision: 1, values: [{ key: 'gooseMode', value: 'workspace-write', isMutable: true }] })),
  savePreferences: vi.fn(async (values) => ({ revision: 2, values })),
}));

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('./ConfigContext', () => ({ useConfig: () => ({ extensionsList: [] }) }));
vi.mock('../hooks/useNavigation', () => ({ useNavigation: () => vi.fn() }));
vi.mock('../codepro/startCodeProSession', () => ({ startCodeProSession: vi.fn() }));
vi.mock('../sessions', () => ({ createSession: vi.fn() }));
vi.mock('./ModelAndProviderContext', () => ({
  useModelAndProvider: () => ({ getCurrentModelAndProvider: async () => ({}) }),
}));
vi.mock('./alerts', () => ({
  AlertType: { Error: 'error', Warning: 'warning', Info: 'info' },
  useAlerts: () => ({ alerts: [], addAlert: vi.fn(), clearAlerts: vi.fn() }),
}));
vi.mock('../hooks/useAudioRecorder', () => ({ useAudioRecorder: () => ({ isEnabled: false }) }));
vi.mock('./custom-agents/AgentSelector', () => ({ AgentSelector: () => null }));
vi.mock('./settings/models/bottom_bar/ModelsBottomBar', () => ({ default: () => null }));
vi.mock('./bottom_menu/BottomMenuExtensionSelection', () => ({
  BottomMenuExtensionSelection: () => null,
}));
vi.mock('./bottom_menu/CostTracker', () => ({ CostTracker: () => null }));
vi.mock('./bottom_menu/ContextWindowIndicator', () => ({ ContextWindowIndicator: () => null }));
vi.mock('./MentionPopover', () => ({ default: () => null }));
vi.mock('./ui/Diagnostics', () => ({ DiagnosticsModal: () => null }));

const candidate = {
  requestedPath: 'D:\\existing-files',
  normalizedPath: 'D:\\existing-files',
  normalizedIdentity: 'd:\\existing-files',
  canonicalPath: null,
  source: 'selected' as const,
  state: 'missing' as const,
  isGitRepository: false,
  displayName: 'existing-files',
  suggestedProjectId: 'existing-files-123',
  error: null,
};

describe('CodeProHub real composer setup', () => {
  beforeEach(() => {
    clearNewTaskDraft('codepro');
    clearNewTaskDraft('code');
    vi.clearAllMocks();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
        unobserve() {}
      }
    );
    window.electron.defaultCodeProWorkspacePath = vi
      .fn()
      .mockResolvedValue(candidate.normalizedPath);
    window.electron.directoryChooser = vi
      .fn()
      .mockResolvedValue({ canceled: false, filePaths: [candidate.normalizedPath] });
    window.electron.inspectCodeProWorkspace = vi.fn().mockResolvedValue([candidate]);
    vi.mocked(startCodeProSession).mockResolvedValue({
      session: {
        id: 'started-session',
        name: 'new task',
        message_count: 0,
        created_at: '',
        updated_at: '',
        working_dir: candidate.normalizedPath,
        project_id: candidate.suggestedProjectId,
        extension_data: {},
      },
      projectId: candidate.suggestedProjectId,
      confirmation: {
        workingDir: candidate.normalizedPath,
        normalizedIdentity: candidate.normalizedIdentity,
        created: false,
        displayName: candidate.displayName,
        suggestedProjectId: candidate.suggestedProjectId,
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('restores an unsent prompt and selected project after leaving the new-task page', async () => {
    const prompt = '  中文 draft 🙂\n保留换行和空格  ';
    const view = render(
      <CodeProHub launchIntent={{ draftOnly: true, workingDir: 'D:\\project' }} />,
      { wrapper: IntlTestWrapper }
    );
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: prompt } });
    view.unmount();
    render(<CodeProHub />, { wrapper: IntlTestWrapper });
    expect(screen.getByTestId('chat-input')).toHaveValue(prompt);
    expect(startCodeProSession).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(window.electron.inspectCodeProWorkspace).toHaveBeenCalledWith({
        prompt: '',
        selectedWorkingDir: 'D:\\project',
      })
    );
  });

  it('selecting another folder preserves the draft and waits for Send', () => {
    updateNewTaskDraft('codepro', { text: '未发送任务', workingDir: 'D:\\old' });
    render(<CodeProHub launchIntent={{ draftOnly: true, workingDir: 'D:\\new' }} />, {
      wrapper: IntlTestWrapper,
    });
    expect(screen.getByTestId('chat-input')).toHaveValue('未发送任务');
    expect(window.electron.inspectCodeProWorkspace).not.toHaveBeenCalled();
    expect(startCodeProSession).not.toHaveBeenCalled();
  });

  it('clears the draft workspace, keeps its text and allocates a default workspace on Send', async () => {
    updateNewTaskDraft('codepro', { text: 'Keep this draft', workingDir: 'D:/old' });
    const view = render(<CodeProHub />, { wrapper: IntlTestWrapper });
    await userEvent.click(screen.getByRole('button', { name: 'Clear selected workspace' }));
    expect(screen.queryByRole('button', { name: 'Clear selected workspace' })).toBeNull();
    expect(startCodeProSession).not.toHaveBeenCalled();
    view.unmount();
    render(<CodeProHub />, { wrapper: IntlTestWrapper });
    expect(screen.getByTestId('chat-input')).toHaveValue('Keep this draft');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(window.electron.inspectCodeProWorkspace).toHaveBeenCalledWith({
      prompt: '', selectedWorkingDir: candidate.normalizedPath,
    }));
    expect(window.electron.defaultCodeProWorkspacePath).toHaveBeenCalled();
  });

  it('restores attachment previews, persists removal, and retains the remaining attachment on navigation', async () => {
    updateNewTaskDraft('codepro', {
      text: 'with attachments',
      images: [{ id: 'pasted', dataUrl: 'data:image/png;base64,YQ==', isLoading: false }],
      files: [
        {
          id: 'document',
          path: 'D:\\drafts\\notes.txt',
          name: 'notes.txt',
          type: 'text/plain',
          isImage: false,
          isVideo: false,
        },
      ],
    });
    const view = render(<CodeProHub />, { wrapper: IntlTestWrapper });
    expect(screen.getByText('notes.txt')).toBeVisible();
    expect(screen.getByRole('img')).toHaveAttribute('src', 'data:image/png;base64,YQ==');
    await userEvent.click(screen.getByRole('button', { name: /remove image/i }));
    view.unmount();
    render(<CodeProHub />, { wrapper: IntlTestWrapper });
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('notes.txt')).toBeVisible();
    expect(screen.getByTestId('chat-input')).toHaveValue('with attachments');
  });

  it('does not resurrect a draft after an accepted Send', async () => {
    const view = render(<CodeProHub />, { wrapper: IntlTestWrapper });
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'send once' } });
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(screen.getByTestId('chat-input')).not.toBeDisabled();
    view.unmount();
    render(<CodeProHub />, { wrapper: IntlTestWrapper });
    expect(screen.getByTestId('chat-input')).toHaveValue('');
  });

  it('retains a failed submission across navigation', async () => {
    vi.mocked(window.electron.inspectCodeProWorkspace).mockRejectedValueOnce(
      new Error('fixture failure')
    );
    const view = render(<CodeProHub />, { wrapper: IntlTestWrapper });
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'retry my task' } });
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('alert');
    view.unmount();
    render(<CodeProHub />, { wrapper: IntlTestWrapper });
    expect(screen.getByTestId('chat-input')).toHaveValue('retry my task');
  });

  it('keeps a selected skill editable without allocating a workspace until Send', async () => {
    const user = userEvent.setup();
    render(
      <CodeProHub
        launchIntent={{
          draftOnly: true,
          initialMessage: { msg: '/comfyui ', images: [] },
          noAutoSubmit: true,
        }}
      />,
      { wrapper: IntlTestWrapper }
    );
    const input = screen.getByTestId('chat-input');
    expect(input).toHaveValue('/comfyui ');
    await user.type(input, '生成一个视频');
    expect(window.electron.defaultCodeProWorkspacePath).not.toHaveBeenCalled();
    expect(window.electron.inspectCodeProWorkspace).not.toHaveBeenCalled();
    expect(startCodeProSession).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(startCodeProSession).toHaveBeenCalledOnce());
    expect(startCodeProSession).toHaveBeenCalledWith(
      expect.objectContaining({ initialMessage: { msg: '/comfyui 生成一个视频', images: [] } })
    );
  });

  it('preserves the draft while inspecting a fresh workspace without queue or stop controls, then starts once', async () => {
    let resolveInspection!: (value: (typeof candidate)[]) => void;
    vi.mocked(window.electron.inspectCodeProWorkspace).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInspection = resolve;
        })
    );
    const user = userEvent.setup();
    render(<CodeProHub />, { wrapper: IntlTestWrapper });
    const input = screen.getByTestId('chat-input');
    await user.type(input, 'prepare project');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(window.electron.inspectCodeProWorkspace).toHaveBeenCalledOnce());
    expect(input).toHaveValue('prepare project');
    expect(input).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.queryByText('Message Queue')).toBeNull();
    expect(screen.queryByText('Queue Paused')).toBeNull();
    const dropped = createEvent.drop(input, {
      dataTransfer: { files: [new File(['extra'], 'extra.txt')], types: ['Files'] },
    });
    fireEvent(input, dropped);
    expect(dropped.defaultPrevented).toBe(true);
    expect(screen.queryByText('extra.txt')).toBeNull();
    await user.keyboard('{Enter}{Enter}');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(window.electron.inspectCodeProWorkspace).toHaveBeenCalledOnce();
    expect(startCodeProSession).not.toHaveBeenCalled();
    await act(async () => resolveInspection([candidate]));
    await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(startCodeProSession).toHaveBeenCalledOnce();
    expect(startCodeProSession).toHaveBeenCalledWith(expect.objectContaining({
      candidate,
      initialMessage: { msg: 'prepare project', images: [] },
      allExtensions: [],
      workspaceOrigin: 'default',
    }));
    expect(input).toHaveValue('');
    expect(screen.queryByText('Queue Paused')).toBeNull();
  });

  it('blocks repeated submission during asynchronous inspection without creating a queue', async () => {
    let resolveInspection!: (value: (typeof candidate)[]) => void;
    vi.mocked(window.electron.inspectCodeProWorkspace).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInspection = resolve;
        })
    );
    render(<CodeProHub />, { wrapper: IntlTestWrapper });
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: 'one request' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(window.electron.inspectCodeProWorkspace).toHaveBeenCalledOnce());
    expect(input).toBeDisabled();
    await userEvent.keyboard('{Enter}{Enter}');
    expect(window.electron.inspectCodeProWorkspace).toHaveBeenCalledOnce();
    expect(screen.queryByText('Message Queue')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    await act(async () => resolveInspection([candidate]));
    await waitFor(() => expect(startCodeProSession).toHaveBeenCalledOnce());
    expect(navigate).toHaveBeenCalledOnce();
  });

  it('lets the user choose permissions before the first send and uses the confirmed permission for its first send', async () => {
    const user = userEvent.setup();
    render(<CodeProHub />, { wrapper: IntlTestWrapper });
    await user.click(screen.getByRole('button', { name: 'How should actions be approved?' }));
    await user.click(screen.getByRole('radio', { name: /Full access/ }));
    const input = screen.getByTestId('chat-input');
    await user.type(input, '帮我开一个计时员');
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(startCodeProSession).toHaveBeenCalledWith(
        expect.objectContaining({
          initialPermissionPreset: 'danger-full-access',
          initialMessage: { msg: '帮我开一个计时员', images: [] },
        })
      )
    );
  });
});
