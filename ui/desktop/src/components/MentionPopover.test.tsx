import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listAgentMentionItems, listSlashCommandItems } from '../acp/autocomplete';
import { IntlTestWrapper } from '../i18n/test-utils';
import MentionPopover from './MentionPopover';
import { loadToolbox } from '../acp/toolbox';
import { acpListSessions } from '../acp/sessions';
vi.mock('../acp/sessions', () => ({
  acpListSessions: vi.fn().mockResolvedValue({ sessions: [], nextCursor: null }),
}));
vi.mock('../acp/toolbox', () => ({ loadToolbox: vi.fn() }));

vi.mock('../acp/autocomplete', () => ({
  listAgentMentionItems: vi.fn().mockResolvedValue([]),
  listSlashCommandItems: vi.fn().mockResolvedValue([]),
}));

const anchorRef = { current: document.createElement('textarea') };
afterEach(() => vi.restoreAllMocks());

describe('MentionPopover while the workspace is unbound', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadToolbox).mockResolvedValue({
      model: { methods: [], capabilities: [], external: [], apps: [] },
      errors: {},
      warnings: [],
    });
    HTMLElement.prototype.scrollIntoView = vi.fn();
    window.electron.listFiles = vi.fn().mockResolvedValue([]);
    window.electron.workspacePanel = vi.fn().mockResolvedValue({ entries: [] });
    vi.mocked(acpListSessions).mockResolvedValue({ sessions: [], nextCursor: null });
  });

  it('uses the shared command catalog for the add menu and keeps control-only actions in slash commands', async () => {
    render(<MentionPopover isOpen addOnly isSlashCommand onClose={vi.fn()} onSelect={vi.fn()}
      anchorRef={anchorRef} query="" selectedIndex={0} onSelectedIndexChange={vi.fn()} workingDir="" />,
    { wrapper: IntlTestWrapper });
    expect(await screen.findByRole('option', { name: /Custom agent/ })).toBeVisible();
    expect(screen.getByRole('option', { name: /^File/ })).toBeVisible();
    expect(screen.queryByRole('option', { name: /Export conversation/ })).not.toBeInTheDocument();
    expect(document.body.querySelector('[data-composer-menu="add"]')).toHaveClass('composer-menu-surface');
    expect(listSlashCommandItems).not.toHaveBeenCalled();
    expect(loadToolbox).not.toHaveBeenCalled();
  });

  it('requests add-menu inventory only on demand and appends bounded batches', async () => {
    let finish!: (items: Awaited<ReturnType<typeof listSlashCommandItems>>) => void;
    vi.mocked(listSlashCommandItems).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    render(<MentionPopover isOpen addOnly isSlashCommand onClose={vi.fn()} onSelect={vi.fn()}
      anchorRef={anchorRef} query="" selectedIndex={0} onSelectedIndexChange={vi.fn()} workingDir="/fixture" />,
    { wrapper: IntlTestWrapper });
    expect(screen.getAllByRole('option')).toHaveLength(4);
    fireEvent.wheel(screen.getByRole('listbox'), { deltaY: 100 });
    await waitFor(() => expect(listSlashCommandItems).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('status')).toHaveTextContent('Loading commands');
    fireEvent.wheel(screen.getByRole('listbox'), { deltaY: 100 });
    expect(listSlashCommandItems).toHaveBeenCalledTimes(1);
    await act(async () => finish(Array.from({ length: 60 }, (_, i) => ({
      name: `skill-${String(i).padStart(2, '0')}`, relativePath: `skill-${i}`, itemType: 'Skill' as const, extra: 'test skill',
    }))));
    expect(screen.getAllByRole('option').length).toBeLessThanOrEqual(20);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(screen.getAllByRole('option')).toHaveLength(40);
    expect(listSlashCommandItems).toHaveBeenCalledTimes(1);
  });

  it('reuses a menu snapshot on reopen, refreshes it on search, and isolates workspaces', async () => {
    vi.mocked(listSlashCommandItems).mockResolvedValueOnce([{ name: 'cached skill', relativePath: 'cached-skill', itemType: 'Skill', extra: 'fixture' }]);
    const props = { isOpen: true, addOnly: true, isSlashCommand: true, onClose: vi.fn(), onSelect: vi.fn(), anchorRef, query: '', selectedIndex: 0, onSelectedIndexChange: vi.fn(), workingDir: '/fixture' };
    const view = render(<MentionPopover {...props} />, { wrapper: IntlTestWrapper });
    fireEvent.wheel(screen.getByRole('listbox'), { deltaY: 100 });
    await screen.findByRole('option', { name: /cached skill/ });
    await act(async () => {});
    view.rerender(<MentionPopover {...props} isOpen={false} />);
    view.rerender(<MentionPopover {...props} />);
    expect(screen.getByRole('option', { name: /cached skill/ })).toBeVisible();
    vi.mocked(listSlashCommandItems).mockResolvedValueOnce([
      { name: 'new skill', relativePath: 'new-skill', itemType: 'Skill', extra: 'fixture' },
    ]);
    view.rerender(<MentionPopover {...props} query="skill" />);
    await screen.findByRole('option', { name: /new skill/i });
    expect(screen.queryByRole('option', { name: /cached skill/i })).toBeNull();
    view.rerender(<MentionPopover {...props} workingDir="/other" />);
    expect(screen.queryByRole('option', { name: /new skill/i })).toBeNull();
    expect(screen.queryByRole('option', { name: /cached skill/ })).toBeNull();
  });

  it('shows Toolbox skills, MCP and built-in tools even when slash discovery is pending', async () => {
    vi.mocked(listSlashCommandItems).mockReturnValueOnce(new Promise(() => {}));
    const mcp = {
      id: 'external:fixture',
      name: 'Fixture MCP',
      description: 'Connected service',
      kind: 'external' as const,
      source: 'extension' as const,
      status: 'disabled' as const,
      actions: [],
    };
    vi.mocked(loadToolbox).mockResolvedValue({
      model: {
        methods: [
          {
            id: 'skill:office-docx',
            name: 'office-docx',
            description: 'Document skill',
            kind: 'skill',
            source: 'source',
            status: 'ready',
            actions: [],
          },
        ],
        capabilities: [
          {
            id: 'builtin:developer',
            name: 'Developer',
            description: 'Read and edit files',
            kind: 'builtin',
            source: 'extension',
            status: 'configured',
            actions: [],
          },
        ],
        external: [mcp],
        apps: [],
      },
      errors: {},
      warnings: [],
    });
    const onSelect = vi.fn();
    render(
      <MentionPopover
        isOpen
        onClose={vi.fn()}
        onSelect={onSelect}
        anchorRef={anchorRef}
        query=""
        isSlashCommand
        selectedIndex={0}
        onSelectedIndexChange={vi.fn()}
        workingDir="/fixture"
      />,
      { wrapper: IntlTestWrapper }
    );
    expect(await screen.findByRole('option', { name: /office-docx/ })).toBeVisible();
    expect(screen.getByRole('option', { name: /Developer/ })).toBeVisible();
    const entry = screen.getByRole('option', { name: /Fixture MCP/ });
    expect(entry).toHaveTextContent('Disabled');
    fireEvent.click(entry);
    expect(onSelect).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ toolboxItem: mcp })
    );
    expect(loadToolbox).toHaveBeenCalledWith('/fixture', undefined, expect.objectContaining({ includeUsage: false, onPartial: expect.any(Function) }));
  });

  it('shows local goal and plan commands while remote commands are pending and selects by click', async () => {
    vi.mocked(listSlashCommandItems).mockReturnValueOnce(new Promise(() => {}));
    const onSelect = vi.fn();
    const { rerender } = render(
      <MentionPopover
        isOpen
        onClose={vi.fn()}
        onSelect={onSelect}
        anchorRef={anchorRef}
        query=""
        isSlashCommand
        selectedIndex={0}
        onSelectedIndexChange={vi.fn()}
        workingDir=""
      />,
      { wrapper: IntlTestWrapper }
    );
    expect(await screen.findByRole('option', { name: /^Goal \/goal/ })).toBeVisible();
    expect(screen.getByRole('option', { name: /^Plan \/plan / })).toBeVisible();
    rerender(
      <MentionPopover
        isOpen
        onClose={vi.fn()}
        onSelect={onSelect}
        anchorRef={anchorRef}
        query="permission"
        isSlashCommand
        selectedIndex={0}
        onSelectedIndexChange={vi.fn()}
        workingDir=""
      />
    );
    fireEvent.click(await screen.findByRole('option', { name: /^Permissions/ }));
    expect(onSelect).toHaveBeenCalledWith('/permission ');
    expect(screen.queryByRole('option', { name: /^Goal \/goal/ })).toBeNull();
  });

  it('does not scan workspace mentions or files without a workspace', async () => {
    render(
      <MentionPopover
        isOpen
        onClose={vi.fn()}
        onSelect={vi.fn()}
        anchorRef={anchorRef}
        query=""
        isSlashCommand={false}
        selectedIndex={0}
        onSelectedIndexChange={vi.fn()}
        workingDir=""
      />,
      { wrapper: IntlTestWrapper }
    );

    await waitFor(() => {
      expect(listAgentMentionItems).not.toHaveBeenCalled();
      expect(listSlashCommandItems).not.toHaveBeenCalled();
      expect(window.electron.listFiles).not.toHaveBeenCalled();
    });
  });

  it('shows conversations without a project, excludes self, and inserts a stable native reference', async () => {
    const session = {
      id: 'source',
      name: 'School project',
      workingDir: 'D:/school',
      updatedAt: '2026-11-01T10:00:00Z',
      createdAt: '',
      messageCount: 4,
    };
    vi.mocked(acpListSessions).mockResolvedValue({
      sessions: [session, { ...session, id: 'current' }],
      nextCursor: null,
    });
    const onSelect = vi.fn();
    render(
      <MentionPopover
        isOpen
        onClose={vi.fn()}
        onSelect={onSelect}
        anchorRef={anchorRef}
        query=""
        isSlashCommand={false}
        selectedIndex={0}
        onSelectedIndexChange={vi.fn()}
        workingDir=""
        sessionId="current"
      />,
      { wrapper: IntlTestWrapper }
    );
    const row = await screen.findByRole('option', { name: /School project/ });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith(
      expect.stringMatching(/^@\[School project\]\(dsh-session:/)
    );
    expect(window.electron.workspacePanel).not.toHaveBeenCalled();
  });

  it('shows typed file results while conversations are pending and preserves filenames with spaces', async () => {
    vi.mocked(acpListSessions).mockReturnValue(new Promise(() => {}));
    window.electron.workspacePanel = vi
      .fn()
      .mockResolvedValue({
        entries: [{ name: 'odd file.xyz', path: 'src/odd file.xyz', kind: 'file' }],
        truncated: true,
      });
    const onSelect = vi.fn();
    render(
      <MentionPopover
        isOpen
        onClose={vi.fn()}
        onSelect={onSelect}
        anchorRef={anchorRef}
        query="odd file"
        isSlashCommand={false}
        selectedIndex={0}
        onSelectedIndexChange={vi.fn()}
        workingDir="D:/project"
      />,
      { wrapper: IntlTestWrapper }
    );
    fireEvent.click(await screen.findByRole('option', { name: /odd file.xyz/ }));
    expect(onSelect).toHaveBeenCalledWith('"D:/project/src/odd file.xyz" ');
    expect(window.electron.workspacePanel).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'search', query: 'odd file' })
    );
  });

  it('discards a stale search response after the query changes', async () => {
    let finish!: (value: { sessions: []; nextCursor: null }) => void;
    vi.mocked(acpListSessions).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const props = {
      isOpen: true,
      onClose: vi.fn(),
      onSelect: vi.fn(),
      anchorRef,
      query: 'old',
      isSlashCommand: false,
      selectedIndex: 0,
      onSelectedIndexChange: vi.fn(),
      workingDir: '',
    };
    const view = render(<MentionPopover {...props} />, { wrapper: IntlTestWrapper });
    await waitFor(() => expect(acpListSessions).toHaveBeenCalled());
    vi.mocked(acpListSessions).mockResolvedValue({
      sessions: [
        {
          id: 'new',
          name: 'new result',
          workingDir: '',
          createdAt: '',
          updatedAt: '',
          messageCount: 2,
        },
      ],
      nextCursor: null,
    });
    view.rerender(<MentionPopover {...props} query="new" />);
    await screen.findByRole('option', { name: /new result/ });
    await act(async () => finish({ sessions: [], nextCursor: null }));
    expect(screen.getByRole('option', { name: /new result/ })).toBeVisible();
  });

  it('loads built-in slash commands without requiring a workspace', async () => {
    render(
      <MentionPopover
        isOpen
        onClose={vi.fn()}
        onSelect={vi.fn()}
        anchorRef={anchorRef}
        query=""
        isSlashCommand
        selectedIndex={0}
        onSelectedIndexChange={vi.fn()}
        workingDir=""
      />,
      { wrapper: IntlTestWrapper }
    );

    await waitFor(() => expect(listSlashCommandItems).toHaveBeenCalledWith('', undefined));
    expect(listAgentMentionItems).not.toHaveBeenCalled();
    expect(window.electron.listFiles).not.toHaveBeenCalled();
  });
});

it('follows an open menu through window and pane layout changes and stops observing on close', async () => {
  let nextFrame: (time: number) => void = () => {};
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    nextFrame = callback;
    return 7;
  });
  const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  let rect = new window.DOMRect(200, 400, 600, 20);
  vi.spyOn(anchorRef.current, 'getBoundingClientRect').mockImplementation(() => rect);
  const view = render(
    <MentionPopover
      isOpen
      anchorRef={anchorRef}
      onClose={vi.fn()}
      onSelect={vi.fn()}
      query=""
      isSlashCommand
      selectedIndex={0}
      onSelectedIndexChange={vi.fn()}
      workingDir=""
    />,
    { wrapper: IntlTestWrapper }
  );
  const menu = document.body.querySelector('[data-composer-menu]');
  expect(menu).toHaveStyle({ left: '200px', top: '390px', width: '420px' });
  rect = new window.DOMRect(80, 250, 400, 20);
  act(() => nextFrame(16));
  expect(menu).toHaveStyle({ left: '80px', top: '240px', width: '280px' });
  // A panel can move the anchor without a viewport resize or new typed input.
  rect = new window.DOMRect(160, 290, 400, 20);
  act(() => nextFrame(32));
  expect(menu).toHaveStyle({ left: '160px', top: '280px', width: '280px' });
  view.unmount();
  expect(cancel).toHaveBeenCalledWith(7);
});
