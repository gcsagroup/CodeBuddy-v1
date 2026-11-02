import { toast } from 'react-toastify';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { AppEvents } from '../../constants/events';
import {
  acpArchiveSession,
  acpExportSession,
  acpListSessions,
  acpUnarchiveSession,
  type SessionListItem,
} from '../../acp/sessions';
import SessionListView from './SessionListView';

vi.mock('../../acp/sessions', () => ({
  acpListSessions: vi.fn(),
  acpArchiveSession: vi.fn(),
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
    vi.mocked(acpArchiveSession).mockImplementation(async sessionId => {
      window.dispatchEvent(new CustomEvent(AppEvents.SESSION_ARCHIVED, { detail: { sessionId } }));
    });
    vi.mocked(acpUnarchiveSession).mockImplementation(async sessionId => {
      window.dispatchEvent(new CustomEvent(AppEvents.SESSION_UNARCHIVED, { detail: { sessionId } }));
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

    fireEvent.change(screen.getByLabelText('History view'), { target: { value: 'archived' } });
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
    expect(screen.getAllByTitle('Export session')[0]).toBeEnabled();
    fireEvent.change(screen.getByLabelText('History view'), { target: { value: 'archived' } });
    await screen.findByText('Archived project A');
    await userEvent.click(screen.getByText('Archived project A'));
    expect(onSelect).not.toHaveBeenCalled();
    for (const title of ['Open in new window', 'Edit session name', 'Export session']) {
      expect(screen.getByTitle(title)).toBeDisabled();
    }
    expect(
      screen.getByText(
        'Restore this session before opening, editing, duplicating, exporting or sharing it.'
      )
    ).toBeVisible();
    expect(screen.getByTitle('Unarchive session')).toBeEnabled();
    expect(screen.getByTitle('Delete session')).toBeEnabled();
  });

  it('reports export errors instead of leaving an unhandled request', async () => {
    vi.mocked(acpExportSession).mockRejectedValueOnce(new Error('Snapshot is unavailable'));
    render(<SessionListView onSelectSession={vi.fn()} workspaceMode="unified" />, {
      wrapper: IntlTestWrapper,
    });
    await screen.findByText('Recent project A');
    await userEvent.click(screen.getAllByTitle('Export session')[0]);
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
});
