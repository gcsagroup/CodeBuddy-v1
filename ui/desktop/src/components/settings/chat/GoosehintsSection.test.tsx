import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { acpGetSessionListItem } from '../../../acp/sessions';
import { useChatContext } from '../../../contexts/ChatContext';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import { GoosehintsSection } from './GoosehintsSection';

const workingDirMocks = vi.hoisted(() => ({
  chooseOrdinaryWorkingDir: vi.fn(),
  getInitialWorkingDir: vi.fn(),
}));

vi.mock('../../../acp/sessions', () => ({
  acpGetSessionListItem: vi.fn(),
}));

vi.mock('../../../contexts/ChatContext', () => ({
  useChatContext: vi.fn(),
}));

vi.mock('../../../utils/workingDir', () => workingDirMocks);

vi.mock('./GoosehintsModal', () => ({
  GoosehintsModal: ({
    directory,
    setIsGoosehintsModalOpen,
  }: {
    directory: string;
    setIsGoosehintsModalOpen: (open: boolean) => void;
  }) => (
    <div role="dialog" data-directory={directory}>
      {directory}
      <button onClick={() => setIsGoosehintsModalOpen(false)}>Close modal</button>
    </div>
  ),
}));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('GoosehintsSection authoritative session directory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workingDirMocks.chooseOrdinaryWorkingDir.mockResolvedValue('D:/chosen/project');
    workingDirMocks.getInitialWorkingDir.mockReturnValue('');
  });

  const setSession = (sessionId: string) => {
    vi.mocked(useChatContext).mockReturnValue({
      chat: { sessionId },
    } as unknown as NonNullable<ReturnType<typeof useChatContext>>);
  };

  const renderSection = () =>
    render(<GoosehintsSection />, {
      wrapper: IntlTestWrapper,
    });

  it('lets global settings choose an explicit project when no project window is bound', async () => {
    setSession('');
    renderSection();

    const configure = screen.getByRole('button', { name: 'Choose folder' });
    expect(configure).toBeEnabled();
    expect(acpGetSessionListItem).not.toHaveBeenCalled();
    fireEvent.click(configure);
    await waitFor(() => expect(workingDirMocks.chooseOrdinaryWorkingDir).toHaveBeenCalledWith(''));
    expect(screen.getByRole('dialog')).toHaveAttribute('data-directory', 'D:/chosen/project');
  });

  it('uses the explicit project window directory before a session has started', async () => {
    setSession('');
    workingDirMocks.getInitialWorkingDir.mockReturnValue('D:/requested/project');
    renderSection();

    const configure = await screen.findByRole('button', { name: 'Configure' });
    expect(configure).toBeEnabled();
    fireEvent.click(configure);

    expect(workingDirMocks.chooseOrdinaryWorkingDir).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveAttribute('data-directory', 'D:/requested/project');
  });

  it('enables only for the authoritative session cwd and passes it to the modal', async () => {
    setSession('session-1');
    vi.mocked(acpGetSessionListItem).mockResolvedValue({
      workingDir: 'D:/authoritative/project',
    } as Awaited<ReturnType<typeof acpGetSessionListItem>>);
    renderSection();

    const configure = screen.getByRole('button', { name: 'Configure' });
    expect(configure).toBeDisabled();
    await waitFor(() => expect(configure).toBeEnabled());
    expect(acpGetSessionListItem).toHaveBeenCalledWith('session-1');

    fireEvent.click(configure);

    expect(screen.getByRole('dialog')).toHaveAttribute(
      'data-directory',
      'D:/authoritative/project'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close modal' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('fails closed without leaking a private path when the authoritative lookup rejects', async () => {
    const privatePath = 'C:\\Users\\Alice\\Private\\session.db';
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    setSession('session-1');
    vi.mocked(acpGetSessionListItem).mockRejectedValue(
      new Error(`session lookup failed at ${privatePath}`)
    );
    renderSection();

    await waitFor(() => expect(acpGetSessionListItem).toHaveBeenCalledWith('session-1'));
    expect(screen.getByRole('button', { name: 'Configure' })).toBeDisabled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(privatePath);
    expect(
      JSON.stringify([
        ...consoleError.mock.calls,
        ...consoleWarn.mock.calls,
        ...consoleLog.mock.calls,
      ])
    ).not.toContain(privatePath);
    consoleError.mockRestore();
    consoleWarn.mockRestore();
    consoleLog.mockRestore();
  });

  it('fails closed when the authoritative lookup returns an empty cwd', async () => {
    setSession('session-1');
    vi.mocked(acpGetSessionListItem).mockResolvedValue({
      workingDir: '   ',
    } as Awaited<ReturnType<typeof acpGetSessionListItem>>);
    renderSection();

    await waitFor(() => expect(acpGetSessionListItem).toHaveBeenCalledWith('session-1'));
    expect(screen.getByRole('button', { name: 'Configure' })).toBeDisabled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('ignores a stale session lookup that resolves after the current session', async () => {
    const oldLookup = deferred<Awaited<ReturnType<typeof acpGetSessionListItem>>>();
    const currentLookup = deferred<Awaited<ReturnType<typeof acpGetSessionListItem>>>();
    const pendingLookup = deferred<Awaited<ReturnType<typeof acpGetSessionListItem>>>();
    vi.mocked(acpGetSessionListItem).mockImplementation((sessionId) => {
      if (sessionId === 'session-old') return oldLookup.promise;
      if (sessionId === 'session-current') return currentLookup.promise;
      return pendingLookup.promise;
    });
    setSession('session-old');
    const { rerender } = renderSection();
    await waitFor(() => expect(acpGetSessionListItem).toHaveBeenCalledWith('session-old'));

    setSession('session-current');
    rerender(<GoosehintsSection />);
    await waitFor(() => expect(acpGetSessionListItem).toHaveBeenCalledWith('session-current'));

    await act(async () => {
      currentLookup.resolve({
        workingDir: 'D:/current/project',
      } as Awaited<ReturnType<typeof acpGetSessionListItem>>);
    });
    const configure = screen.getByRole('button', { name: 'Configure' });
    await waitFor(() => expect(configure).toBeEnabled());
    fireEvent.click(configure);
    expect(screen.getByRole('dialog')).toHaveAttribute('data-directory', 'D:/current/project');

    setSession('session-pending');
    rerender(<GoosehintsSection />);
    await waitFor(() => expect(acpGetSessionListItem).toHaveBeenCalledWith('session-pending'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(configure).toBeDisabled();

    await act(async () => {
      oldLookup.resolve({
        workingDir: 'D:/stale/project',
      } as Awaited<ReturnType<typeof acpGetSessionListItem>>);
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(configure).toBeDisabled();
  });
});
