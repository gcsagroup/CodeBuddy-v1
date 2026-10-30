import { fireEvent, render as testingRender, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { SessionActionsContextMenu } from './SessionActionsHeader';
import { acpExportSessionLog } from '../acp/sessions';
import { toast } from 'react-toastify';

vi.mock('../acp/sessions', () => ({
  acpExportSessionLog: vi.fn(),
  acpExportSession: vi.fn(),
  acpForkSession: vi.fn(),
  acpRenameSession: vi.fn(),
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
beforeEach(() => {
  vi.clearAllMocks();
});

describe('SessionActionsContextMenu', () => {
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
