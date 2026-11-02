import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { acpListSessions } from '../../acp/sessions';
import { AppEvents } from '../../constants/events';
import SessionListView from './SessionListView';

vi.mock('../../acp/sessions', () => ({ acpListSessions: vi.fn() }));

type Page = Awaited<ReturnType<typeof acpListSessions>>;
function page(names: string[], nextCursor: string | null = null): Page {
  return {
    nextCursor,
    sessions: names.map((name) => ({
      id: name,
      name,
      sessionType: 'user',
      workingDir: '/isolated-history-fixture',
      createdAt: '2026-09-15T00:00:00Z',
      updatedAt: '2026-09-15T00:00:00Z',
      messageCount: 1,
    })),
  };
}
function deferredPage() {
  let resolve!: (value: Page) => void;
  const promise = new Promise<Page>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function openSearch() {
  fireEvent.keyDown(window, {
    key: 'f',
    ctrlKey: window.electron.platform !== 'darwin',
    metaKey: window.electron.platform === 'darwin',
  });
  return screen.getByPlaceholderText('Search history...');
}

describe('history pagination and search generations', () => {
  beforeEach(() => {
    vi.mocked(acpListSessions).mockReset();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    Object.assign(window.electron, { getConfig: () => ({ GOOSE_DISABLE_NOSTR_SHARING: true }) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('loads all pages without duplicating boundary IDs', async () => {
    vi.mocked(acpListSessions)
      .mockResolvedValueOnce(page(['Page first', 'Page boundary'], 'page-2'))
      .mockResolvedValueOnce(page(['Page boundary', 'Page middle'], 'page-3'))
      .mockResolvedValueOnce(page(['Page final']));
    render(<SessionListView onSelectSession={vi.fn()} workspaceMode="unified" />, {
      wrapper: IntlTestWrapper,
    });
    expect(await screen.findByText('Page final')).toBeVisible();
    for (const name of ['Page first', 'Page boundary', 'Page middle', 'Page final']) {
      expect(screen.getAllByText(name)).toHaveLength(1);
    }
    expect(acpListSessions).toHaveBeenNthCalledWith(
      2,
      'page-2',
      { keyword: '', includeArchived: true },
      'unified'
    );
    expect(acpListSessions).toHaveBeenNthCalledWith(
      3,
      'page-3',
      { keyword: '', includeArchived: true },
      'unified'
    );
  });

  it('refreshes a mounted history card when another view renames its session', async () => {
    const initial = page(['Original title']);
    vi.mocked(acpListSessions).mockResolvedValue(initial);
    render(<SessionListView onSelectSession={vi.fn()} workspaceMode="unified" />, {
      wrapper: IntlTestWrapper,
    });
    await screen.findByText('Original title');
    vi.mocked(acpListSessions).mockResolvedValue({
      ...initial,
      sessions: [{ ...initial.sessions[0], name: 'Renamed title', userSetName: true }],
    });
    act(() => {
      window.dispatchEvent(
        new CustomEvent(AppEvents.SESSION_RENAMED, {
          detail: { sessionId: 'Original title', newName: 'Renamed title', userInitiated: true },
        })
      );
    });
    expect(await screen.findByText('Renamed title')).toBeVisible();
    expect(screen.queryByText('Original title')).not.toBeInTheDocument();
  });

  it('rechecks the current search after a rename changes which sessions match', async () => {
    vi.mocked(acpListSessions).mockResolvedValue(page(['Matching title']));
    render(<SessionListView onSelectSession={vi.fn()} workspaceMode="unified" />, {
      wrapper: IntlTestWrapper,
    });
    await screen.findByText('Matching title');
    fireEvent.change(openSearch(), { target: { value: 'Matching' } });
    await waitFor(() =>
      expect(acpListSessions).toHaveBeenCalledWith(
        undefined,
        { keyword: 'Matching', includeArchived: true },
        'unified'
      )
    );
    vi.mocked(acpListSessions).mockResolvedValue(page([]));
    act(() => {
      window.dispatchEvent(
        new CustomEvent(AppEvents.SESSION_RENAMED, {
          detail: { sessionId: 'Matching title', newName: 'Different title', userInitiated: true },
        })
      );
    });
    await waitFor(() => expect(screen.queryByText('Matching title')).not.toBeInTheDocument());
    expect(screen.getByText('No matching sessions found')).toBeVisible();
    expect(acpListSessions).toHaveBeenLastCalledWith(
      undefined,
      { keyword: 'Matching', includeArchived: true },
      'unified'
    );
  });

  it('ignores an old pagination response after a new keyword and restores all results on clear', async () => {
    const oldNext = deferredPage();
    vi.mocked(acpListSessions).mockImplementation(async (cursor, filter) => {
      if (cursor === 'old-next') return oldNext.promise;
      if (filter?.keyword === 'new') return page(['New matching result']);
      return page(['Initial result'], 'old-next');
    });
    render(<SessionListView onSelectSession={vi.fn()} workspaceMode="unified" />, {
      wrapper: IntlTestWrapper,
    });
    await screen.findByText('Initial result');
    await waitFor(() =>
      expect(acpListSessions).toHaveBeenCalledWith(
        'old-next',
        { keyword: '', includeArchived: true },
        'unified'
      )
    );
    const input = openSearch();
    fireEvent.change(input, { target: { value: 'new' } });
    expect(await screen.findByText('New matching result')).toBeVisible();
    await act(async () => oldNext.resolve(page(['Stale page result'])));
    expect(screen.queryByText('Stale page result')).not.toBeInTheDocument();
    expect(screen.queryByText('Initial result')).not.toBeInTheDocument();
    vi.mocked(acpListSessions).mockResolvedValue(page(['Restored all results']));
    fireEvent.change(input, { target: { value: '' } });
    expect(await screen.findByText('Restored all results')).toBeVisible();
    expect(screen.queryByText('New matching result')).not.toBeInTheDocument();
  });

  it('ignores an older keyword result and a prior workspace-mode result', async () => {
    const alpha = deferredPage();
    const oldMode = deferredPage();
    vi.mocked(acpListSessions).mockImplementation(async (_cursor, filter, mode) => {
      if (mode === 'code') return oldMode.promise;
      if (filter?.keyword === 'alpha') return alpha.promise;
      return page([filter?.keyword === 'beta' ? 'Beta current result' : 'Initial result']);
    });
    const view = render(<SessionListView onSelectSession={vi.fn()} workspaceMode="unified" />, {
      wrapper: IntlTestWrapper,
    });
    await screen.findByText('Initial result');
    const input = openSearch();
    fireEvent.change(input, { target: { value: 'alpha' } });
    await waitFor(() =>
      expect(acpListSessions).toHaveBeenCalledWith(
        undefined,
        { keyword: 'alpha', includeArchived: true },
        'unified'
      )
    );
    fireEvent.change(input, { target: { value: 'beta' } });
    expect(await screen.findByText('Beta current result')).toBeVisible();
    await act(async () => alpha.resolve(page(['Alpha stale result'])));
    expect(screen.queryByText('Alpha stale result')).not.toBeInTheDocument();
    view.rerender(<SessionListView onSelectSession={vi.fn()} workspaceMode="code" />);
    await waitFor(() =>
      expect(acpListSessions).toHaveBeenCalledWith(
        undefined,
        { keyword: 'beta', includeArchived: true },
        'code'
      )
    );
    view.rerender(<SessionListView onSelectSession={vi.fn()} workspaceMode="unified" />);
    await act(async () => oldMode.resolve(page(['Old workspace result'])));
    expect(screen.queryByText('Old workspace result')).not.toBeInTheDocument();
    expect(await screen.findByText('Beta current result')).toBeVisible();
  });
});
