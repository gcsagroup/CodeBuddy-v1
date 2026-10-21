import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { startCodeProSession } from '../codepro/startCodeProSession';
import { CodeProHub } from './codepro/CodeProHub';

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
vi.mock('./bottom_menu/DirSwitcher', () => ({ DirSwitcher: () => null }));
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
    expect(startCodeProSession).toHaveBeenCalledWith({
      candidate,
      initialMessage: { msg: 'prepare project', images: [] },
      allExtensions: [],
    });
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

  it('lets the user choose permissions before the first send and passes only that new-chat draft', async () => {
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
