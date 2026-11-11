import { act, fireEvent, render as testingRender, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { SessionActionsContextMenu } from './SessionActionsHeader';
import { acpArchiveSession, acpDeleteSession, acpExportSession, acpExportSessionLog } from '../acp/sessions';
import { toast } from 'react-toastify';

vi.mock('../acp/sessions', async (original) => ({
  ...(await original<typeof import('../acp/sessions')>()),
  acpExportSessionLog: vi.fn(),
  acpArchiveSession: vi.fn(),
  acpDeleteSession: vi.fn(),
  acpExportSession: vi.fn(),
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());

describe('SessionActionsContextMenu', () => {
  it('closes on durable deletion acknowledgement without waiting for backend resource cleanup', async () => {
    let accept!: () => void;
    vi.mocked(acpDeleteSession).mockImplementationOnce(() => new Promise<void>(resolve => { accept = resolve; }));
    const removed = vi.fn();
    window.addEventListener('session-deleted', removed);
    try {
      testingRender(<SessionActionsContextMenu session={{ id: 'async-delete', name: 'Large history' }}><div>Large history</div></SessionActionsContextMenu>, { wrapper: IntlTestWrapper });
      fireEvent.contextMenu(screen.getByText('Large history'));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete session' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Delete session' }));
      expect(screen.getByRole('dialog')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
      expect(removed).not.toHaveBeenCalled();
      await act(async () => accept());
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(removed).toHaveBeenCalledOnce();
      expect(removed.mock.calls[0][0].detail.sessionId).toBe('async-delete');
    } finally { window.removeEventListener('session-deleted', removed); }
  });

  it('places deletion after archive and requires confirmation before removing the selected conversation', async () => {
    const removed = vi.fn();
    window.addEventListener('session-deleted', removed);
    try {
      testingRender(<SessionActionsContextMenu session={{ id: 'delete-fixture', name: 'Keep files' }}><div>Keep files</div></SessionActionsContextMenu>, { wrapper: IntlTestWrapper });
      fireEvent.contextMenu(screen.getByText('Keep files'));
      const items = await screen.findAllByRole('menuitem');
      const archive = items.findIndex(item => item.textContent === 'Archive session');
      expect(items[archive + 1]).toHaveTextContent('Delete session');
      fireEvent.click(items[archive + 1]);
      expect(await screen.findByRole('dialog')).toHaveTextContent('Files in the workspace will be kept.');
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(acpDeleteSession).not.toHaveBeenCalled();
      fireEvent.contextMenu(screen.getByText('Keep files'));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete session' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Delete session' }));
      await waitFor(() => expect(acpDeleteSession).toHaveBeenCalledExactlyOnceWith('delete-fixture'));
      await waitFor(() => expect(removed).toHaveBeenCalledTimes(1));
      expect(removed.mock.calls[0][0].detail.sessionId).toBe('delete-fixture');
    } finally { window.removeEventListener('session-deleted', removed); }
  });

  it('keeps the confirmation open and does not announce deletion when the backend rejects it', async () => {
    vi.mocked(acpDeleteSession).mockRejectedValueOnce(new Error('Active session'));
    testingRender(<SessionActionsContextMenu session={{ id: 'busy-fixture', name: 'Busy task' }}><div>Busy task</div></SessionActionsContextMenu>, { wrapper: IntlTestWrapper });
    fireEvent.contextMenu(screen.getByText('Busy task'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete session' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete session' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Active session')));
    expect(screen.getByRole('dialog')).toBeVisible();
  });
  it('opens the actual session directory and copies its ID without exporting the conversation', async () => {
    const open = vi.fn().mockResolvedValue(true);
    Object.assign(window.electron, { openDirectoryInExplorer: open });
    testingRender(
      <SessionActionsContextMenu
        session={{ id: 'fixture-id', name: 'Folder task', workingDir: 'C:\\fixture\\task' }}
      >
        <div>Folder task</div>
      </SessionActionsContextMenu>,
      { wrapper: IntlTestWrapper }
    );
    fireEvent.contextMenu(screen.getByText('Folder task'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open folder' }));
    await waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith('C:\\fixture\\task'));
    expect(toast.error).not.toHaveBeenCalled();
    fireEvent.contextMenu(screen.getByText('Folder task'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy session ID' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('fixture-id'));
    expect(acpExportSession).not.toHaveBeenCalled();
  });

  it('reports an unavailable folder rather than claiming it opened', async () => {
    Object.assign(window.electron, { openDirectoryInExplorer: vi.fn().mockResolvedValue(false) });
    testingRender(
      <SessionActionsContextMenu
        session={{ id: 'missing', name: 'Missing task', workingDir: 'C:\\missing' }}
      >
        <div>Missing task</div>
      </SessionActionsContextMenu>,
      { wrapper: IntlTestWrapper }
    );
    fireEvent.contextMenu(screen.getByText('Missing task'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open folder' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('C:\\missing'))
    );
  });

  it('shows archive success only after the host confirms it', async () => {
    let finish!: () => void;
    vi.mocked(acpArchiveSession).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    testingRender(
      <SessionActionsContextMenu session={{ id: 'archive-fixture', name: 'Archive task' }}>
        <div>Archive task</div>
      </SessionActionsContextMenu>,
      { wrapper: IntlTestWrapper }
    );
    fireEvent.contextMenu(screen.getByText('Archive task'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive session' }));
    expect(acpArchiveSession).toHaveBeenCalledExactlyOnceWith('archive-fixture');
    expect(toast.success).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(toast.success).toHaveBeenCalledOnce();
  });
  it('opens chat actions from the sidebar row right-click only', async () => {
    testingRender(
      <SessionActionsContextMenu
        session={{ id: 'session-1', name: 'Ledger chat', sessionType: 'user' }}
      >
        <div>Ledger chat</div>
      </SessionActionsContextMenu>,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.queryByText('Rename session')).not.toBeInTheDocument();
    fireEvent.contextMenu(screen.getByText('Ledger chat'));
    expect(await screen.findByText('Rename session')).toBeVisible();
    expect(screen.getByText('Branch conversation')).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Branch conversation' })).not.toHaveAttribute(
      'data-disabled'
    );
    expect(screen.getByText('View session JSON')).toBeVisible();
    expect(screen.getByText('Export logs')).toBeVisible();
    expect(screen.queryByText('View recent model interactions')).not.toBeInTheDocument();
  });

  it('allows CodePro to branch into independent conversation', async () => {
    testingRender(
      <SessionActionsContextMenu
        session={{ id: 'codepro-1', name: 'CodePro task', sessionType: 'code_pro' }}
      >
        <div>CodePro task</div>
      </SessionActionsContextMenu>,
      { wrapper: IntlTestWrapper }
    );
    fireEvent.contextMenu(screen.getByText('CodePro task'));
    const item = await screen.findByRole('menuitem', { name: 'Branch conversation' });
    expect(item).not.toHaveAttribute('data-disabled');
    expect(item).toHaveAttribute('title', expect.stringContaining('Files remain shared'));
  });

  for (const kind of ['session', 'logs'] as const)
    for (const outcome of ['saved', 'cancelled', 'read-error', 'write-error'])
      it(`exports ${kind} to the chosen desktop destination: ${outcome}`, async () => {
        const exporter = kind === 'logs' ? acpExportSessionLog : acpExportSession;
        const save = vi.fn().mockResolvedValue({
          canceled: outcome === 'cancelled',
          filePath: '/chosen/session.jsonl',
        });
        const write = vi.fn().mockResolvedValue(outcome !== 'write-error');
        Object.assign(window.electron, { showSaveDialog: save, writeFile: write });
        const journal =
          '{"type":"session","id":"native"}\n{"type":"tool/result","data":{"text":"中文"}}\n';
        if (outcome === 'read-error')
          vi.mocked(exporter).mockRejectedValue(new Error('No native log'));
        else vi.mocked(exporter).mockResolvedValue(journal);
        testingRender(
          <SessionActionsContextMenu session={{ id: 'product', name: 'Export chat' }}>
            <div>Export chat</div>
          </SessionActionsContextMenu>,
          { wrapper: IntlTestWrapper }
        );
        fireEvent.contextMenu(screen.getByText('Export chat'));
        fireEvent.click(
          await screen.findByRole('menuitem', {
            name: kind === 'logs' ? 'Export logs' : 'Export session',
          })
        );
        await waitFor(() =>
          expect(save).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              defaultDirectory: 'desktop',
              defaultPath: kind === 'logs' ? 'session-product.jsonl' : 'session-product.json',
            })
          )
        );
        if (outcome === 'cancelled') {
          expect(exporter).not.toHaveBeenCalled();
          expect(write).not.toHaveBeenCalled();
          expect(toast.error).not.toHaveBeenCalled();
        } else if (outcome === 'saved') {
          await waitFor(() =>
            expect(toast.success).toHaveBeenCalledWith(
              kind === 'logs' ? 'Session log saved' : 'Session exported successfully'
            )
          );
          expect(exporter).toHaveBeenCalledWith('product');
          expect(write).toHaveBeenCalledWith('/chosen/session.jsonl', journal);
        } else {
          await waitFor(() => expect(toast.error).toHaveBeenCalled());
          expect(toast.success).not.toHaveBeenCalled();
          if (outcome === 'read-error') expect(write).not.toHaveBeenCalled();
        }
      });
});
