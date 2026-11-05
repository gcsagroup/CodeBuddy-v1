import { toast } from 'react-toastify';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { AppEvents } from '../../constants/events';
import {
  acpArchiveSession,
  acpDeleteSession,
  acpExportSession,
  acpListSessions,
  acpUnarchiveSession,
  type SessionListItem,
} from '../../acp/sessions';
import SessionListView from './SessionListView';

vi.mock('../../acp/sessions', () => ({
  acpListSessions: vi.fn(),
  acpArchiveSession: vi.fn(),
  acpDeleteSession: vi.fn(),
  acpExportSession: vi.fn(),
  acpUnarchiveSession: vi.fn(),
}));

vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const now = '2026-09-15T12:00:00Z';

function session(
  id: string,
  workingDir: string,
  updatedAt: string,
  archivedAt?: string
): SessionListItem {
  return {
    id,
    name: id,
    sessionType: 'code_pro',
    workingDir,
    createdAt: updatedAt,
    updatedAt,
    messageCount: 1,
    archivedAt,
  };
}

describe('history management filters and archive actions', () => {
  beforeEach(() => {
    vi.mocked(acpListSessions).mockReset();
    vi.mocked(acpDeleteSession).mockReset();
    vi.mocked(acpArchiveSession).mockReset();
    vi.mocked(acpUnarchiveSession).mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(now));
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    Object.assign(window.electron, { getConfig: () => ({ GOOSE_DISABLE_NOSTR_SHARING: true }) });
    vi.mocked(acpListSessions).mockImplementation(async (_cursor, filter) => ({
      nextCursor: null,
      sessions: [
        session('Recent project A', 'D:/projects/a', '2026-09-15T10:00:00Z'),
        session('Old project A', 'D:/projects/a', '2026-08-01T10:00:00Z'),
        session('Recent project B', 'D:/projects/b', '2026-09-14T10:00:00Z'),
        session(
          'Archived project A',
          'D:/projects/a',
          '2026-09-13T10:00:00Z',
          '2026-09-14T10:00:00Z'
        ),
      ].filter((item) => filter?.includeArchived || !item.archivedAt),
    }));
    vi.mocked(acpArchiveSession).mockImplementation(async (sessionId) => {
      window.dispatchEvent(new CustomEvent(AppEvents.SESSION_ARCHIVED, { detail: { sessionId } }));
    });
    vi.mocked(acpUnarchiveSession).mockImplementation(async (sessionId) => {
      window.dispatchEvent(
        new CustomEvent(AppEvents.SESSION_UNARCHIVED, { detail: { sessionId } })
      );
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('hides archived sessions by default and exposes a recoverable archived view', async () => {
    render(<SessionListView onSelectSession={vi.fn()} workspaceMode="unified" />, {
      wrapper: IntlTestWrapper,
    });

    expect(await screen.findByText('Recent project A')).toBeVisible();
    expect(screen.queryByText('Archived project A')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Archived' }));
    expect(await screen.findByText('Archived project A')).toBeVisible();
    expect(screen.queryByText('Recent project A')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTitle('Unarchive session'));
    expect(acpUnarchiveSession).toHaveBeenCalledWith('Archived project A');
    await waitFor(() => expect(acpListSessions).toHaveBeenCalledTimes(2));
  });

  it('requires restore before opening or using archived-session actions', async () => {
    const onSelect = vi.fn();
    render(<SessionListView onSelectSession={onSelect} workspaceMode="unified" />, {
      wrapper: IntlTestWrapper,
    });
    await screen.findByText('Recent project A');

    fireEvent.click(screen.getByRole('tab', { name: 'Archived' }));
    await screen.findByText('Archived project A');
    await userEvent.click(screen.getByText('Archived project A'));
    expect(onSelect).not.toHaveBeenCalled();
    for (const title of ['Open in new window', 'Edit session name', 'Export session']) {
      expect(screen.queryByTitle(title)).not.toBeInTheDocument();
    }
    expect(
      screen.getByText(
        'Archiving keeps your conversation and removes it from the sidebar. Restore it here whenever you need it.'
      )
    ).toBeVisible();
    expect(screen.getByTitle('Unarchive session')).toBeEnabled();
    expect(screen.getByTitle('Permanently delete')).toBeEnabled();
  });

  it('reports export errors instead of leaving an unhandled request', async () => {
    vi.mocked(acpExportSession).mockRejectedValueOnce(new Error('Snapshot is unavailable'));
    render(<SessionListView onSelectSession={vi.fn()} workspaceMode="unified" />, {
      wrapper: IntlTestWrapper,
    });
    await screen.findByText('Recent project A');
    await userEvent.click(
      screen.getByRole('button', { name: 'More actions for Recent project A' })
    );
    await userEvent.click(screen.getByTitle('Export session'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to export session: Snapshot is unavailable')
    );
  });

  it('filters the loaded history by project and activity date', async () => {
    render(<SessionListView onSelectSession={vi.fn()} workspaceMode="unified" />, {
      wrapper: IntlTestWrapper,
    });

    await screen.findByText('Recent project A');
    fireEvent.change(screen.getByLabelText('Project filter'), {
      target: { value: 'D:/projects/a' },
    });
    expect(screen.getByText('Old project A')).toBeVisible();
    expect(screen.queryByText('Recent project B')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Date filter'), { target: { value: '7d' } });
    expect(screen.getByText('Recent project A')).toBeVisible();
    expect(screen.queryByText('Old project A')).not.toBeInTheDocument();
  });

  it('archives an active session and reloads the current search generation', async () => {
    render(<SessionListView onSelectSession={vi.fn()} workspaceMode="unified" />, {
      wrapper: IntlTestWrapper,
    });

    await screen.findByText('Recent project A');
    const archiveButtons = screen.getAllByTitle('Archive session');
    await userEvent.click(archiveButtons[0]);
    expect(acpArchiveSession).toHaveBeenCalledWith('Recent project A');
    await waitFor(() => expect(acpListSessions).toHaveBeenCalledTimes(2));
  });
  it('confirms permanent deletion, preserves a failed row, and prevents duplicate submissions', async () => {
    let rejectDelete!: (error: Error) => void;
    vi.mocked(acpDeleteSession).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectDelete = reject;
        })
    );
    render(<SessionListView onSelectSession={vi.fn()} workspaceMode="unified" />, {
      wrapper: IntlTestWrapper,
    });
    await screen.findByText('Recent project A');
    await userEvent.click(screen.getByRole('tab', { name: 'Archived' }));
    await userEvent.click(screen.getByTitle('Permanently delete'));
    expect(acpDeleteSession).not.toHaveBeenCalled();
    let dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Files in the workspace will be kept/)).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(acpDeleteSession).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTitle('Permanently delete'));
    dialog = screen.getByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Permanently delete conversation' })
    );
    expect(within(dialog).getByRole('button', { name: 'Processing...' })).toBeDisabled();
    expect(acpDeleteSession).toHaveBeenCalledTimes(1);
    rejectDelete(new Error('Busy session'));
    await waitFor(() =>
      expect(
        within(dialog).getByRole('button', { name: 'Permanently delete conversation' })
      ).toBeEnabled()
    );
    expect(screen.getByText('Archived project A')).toBeInTheDocument();
    vi.mocked(acpDeleteSession).mockResolvedValueOnce(undefined);
    vi.mocked(acpListSessions).mockResolvedValueOnce({ sessions: [], nextCursor: null });
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Permanently delete conversation' })
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('No archived conversations')).toBeVisible();
    expect(acpDeleteSession).toHaveBeenLastCalledWith('Archived project A');
  });

  it('keeps the archive available when restore fails and permits a retry', async () => {
    vi.mocked(acpUnarchiveSession).mockRejectedValueOnce(new Error('Offline'));
    render(<SessionListView onSelectSession={vi.fn()} workspaceMode="unified" />, {
      wrapper: IntlTestWrapper,
    });
    await screen.findByText('Recent project A');
    await userEvent.click(screen.getByRole('tab', { name: 'Archived' }));
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to update session archive: Offline')
    );
    expect(screen.getByText('Archived project A')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeEnabled();
    expect(acpDeleteSession).not.toHaveBeenCalled();
  });
});
