import { act, fireEvent, render as testingRender, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { SessionActionsContextMenu } from './SessionActionsHeader';
import { acpArchiveSession, acpExportSession, acpExportSessionLog } from '../acp/sessions';
import { AppEvents } from '../constants/events';
import { toast } from 'react-toastify';

vi.mock('../acp/sessions', async (original) => ({
  ...(await original<typeof import('../acp/sessions')>()),
  acpExportSessionLog: vi.fn(),
  acpArchiveSession: vi.fn(),
  acpExportSession: vi.fn(),
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());

describe('SessionActionsContextMenu', () => {
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

  it('announces archive only after the host confirms it', async () => {
    let finish!: () => void;
    vi.mocked(acpArchiveSession).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const archived = vi.fn();
    window.addEventListener(AppEvents.SESSION_ARCHIVED, archived);
    try {
      testingRender(
        <SessionActionsContextMenu session={{ id: 'archive-fixture', name: 'Archive task' }}>
          <div>Archive task</div>
        </SessionActionsContextMenu>,
        { wrapper: IntlTestWrapper }
      );
      fireEvent.contextMenu(screen.getByText('Archive task'));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive session' }));
      expect(acpArchiveSession).toHaveBeenCalledExactlyOnceWith('archive-fixture');
      expect(archived).not.toHaveBeenCalled();
      await act(async () => finish());
      expect(archived).toHaveBeenCalledOnce();
      expect(archived.mock.calls[0][0].detail).toEqual({ sessionId: 'archive-fixture' });
    } finally {
      window.removeEventListener(AppEvents.SESSION_ARCHIVED, archived);
    }
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
    expect(screen.getByText('Duplicate session')).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Duplicate session' })).not.toHaveAttribute(
      'data-disabled'
    );
    expect(screen.getByText('View session JSON')).toBeVisible();
    expect(screen.getByText('Export logs')).toBeVisible();
    expect(screen.queryByText('View recent model interactions')).not.toBeInTheDocument();
  });

  it('disables CodePro copying and explains how to start independent work', async () => {
    testingRender(
      <SessionActionsContextMenu
        session={{ id: 'codepro-1', name: 'CodePro task', sessionType: 'code_pro' }}
      >
        <div>CodePro task</div>
      </SessionActionsContextMenu>,
      { wrapper: IntlTestWrapper }
    );
    fireEvent.contextMenu(screen.getByText('CodePro task'));
    const item = await screen.findByRole('menuitem', { name: 'Duplicate session' });
    expect(item).toHaveAttribute('data-disabled');
    expect(item).toHaveAttribute('title', expect.stringContaining('Start a new task'));
  });

  for (const outcome of ['saved', 'cancelled', 'read-error', 'write-error'])
    it(`exports native logs: ${outcome}`, async () => {
      const save = vi
        .fn()
        .mockResolvedValue({
          canceled: outcome === 'cancelled',
          filePath: '/chosen/session.jsonl',
        });
      const write = vi.fn().mockResolvedValue(outcome !== 'write-error');
      Object.assign(window.electron, { showSaveDialog: save, writeFile: write });
      const journal =
        '{"type":"session","id":"native"}\n{"type":"tool/result","data":{"text":"中文"}}\n';
      if (outcome === 'read-error')
        vi.mocked(acpExportSessionLog).mockRejectedValue(new Error('No native log'));
      else vi.mocked(acpExportSessionLog).mockResolvedValue(journal);
      testingRender(
        <SessionActionsContextMenu session={{ id: 'product', name: 'Export chat' }}>
          <div>Export chat</div>
        </SessionActionsContextMenu>,
        { wrapper: IntlTestWrapper }
      );
      fireEvent.contextMenu(screen.getByText('Export chat'));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Export logs' }));
      await waitFor(() => expect(save).toHaveBeenCalledOnce());
      if (outcome === 'cancelled') {
        expect(acpExportSessionLog).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
        expect(toast.error).not.toHaveBeenCalled();
      } else if (outcome === 'saved') {
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Session log saved'));
        expect(acpExportSessionLog).toHaveBeenCalledWith('product');
        expect(write).toHaveBeenCalledWith('/chosen/session.jsonl', journal);
      } else {
        await waitFor(() => expect(toast.error).toHaveBeenCalled());
        expect(toast.success).not.toHaveBeenCalled();
        if (outcome === 'read-error') expect(write).not.toHaveBeenCalled();
      }
    });
});
