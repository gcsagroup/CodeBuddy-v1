import { fireEvent, render as testingRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSessionPins } from '../../utils/sessionPins';
import { readProjectPins } from '../../utils/projectPins';
import { groupNavigationSessions } from '../../utils/projectSessions';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { NAV_ITEMS, SETTINGS_NAV_ITEM } from '../../hooks/useNavigationItems';
import { PROJECT_ALIAS_STORAGE_KEY } from '../../utils/projectAliases';
import { acpListSessions, acpArchiveSession, type SessionListItem } from '../../acp/sessions';
import {
  NavigationHeaderSlot,
  ProjectSessionGroup,
  SessionRow,
  projectGroupLabelClassName,
} from './NavigationPanel';

vi.mock('../../acp/sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../acp/sessions')>()),
  acpArchiveSession: vi.fn().mockResolvedValue(undefined),
  acpListSessions: vi.fn(),
}));

function render(ui: ReactElement) {
  return testingRender(ui, { wrapper: IntlTestWrapper });
}

beforeEach(() => vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
}));
afterEach(() => vi.unstubAllGlobals());

describe('chat row archive button', () => {
  const session: SessionListItem = {
    id: 'rename-fixture',
    name: 'Original chat',
    workingDir: 'C:/fixture/project',
    createdAt: '2026-10-09',
    updatedAt: '2026-10-09',
    messageCount: 0,
  };

  beforeEach(() => vi.clearAllMocks());

  it('shows full title, update time and workspace on focus without opening the session', async () => {
    const onClick = vi.fn();
    render(<SessionRow session={session} active={false} status={undefined} onClick={onClick} onRenamed={vi.fn()} />);
    await userEvent.tab();
    const card = await screen.findByRole('tooltip');
    expect(within(card).getByText(session.name)).toBeInTheDocument();
    expect(within(card).getByText('project')).toBeInTheDocument();
    expect(within(card).getByText(session.workingDir)).toBeInTheDocument();
    expect(card.querySelector('time')).toHaveAttribute('datetime', '2026-10-09T00:00:00.000Z');
    expect(onClick).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  });

  it('shows the last update as relative and exact time instead of the creation date', async () => {
    const now = Date.now();
    const updatedAt = new Date(now - 14 * 60_000).toISOString();
    render(<SessionRow session={{ ...session, updatedAt }} active={false} status={undefined} onClick={vi.fn()} onRenamed={vi.fn()} />);
    await userEvent.tab();
    const card = await screen.findByRole('tooltip');
    expect(within(card).getByText('14 minutes ago')).toBeVisible();
    const time = card.querySelector('time')!;
    expect(time).toHaveAttribute('datetime', updatedAt);
    expect(time.children).toHaveLength(2);
  });

  it('handles unbound workspaces and missing dates without inventing metadata', async () => {
    render(<SessionRow session={{ ...session, workingDir: '', updatedAt: '', createdAt: '' }} active={false} status={undefined} onClick={vi.fn()} onRenamed={vi.fn()} />);
    await userEvent.tab();
    const card = await screen.findByRole('tooltip');
    expect(within(card).getByText('No workspace')).toBeInTheDocument();
    expect(within(card).getByText('Time unavailable')).toBeInTheDocument();
    expect(card.querySelector('time')).toBeNull();
  });

  it('opens the owning chat by keyboard before the secondary actions', async () => {
    const onClick = vi.fn();
    render(<SessionRow session={session} active={false} status={undefined} onClick={onClick} onRenamed={vi.fn()} />);
    await userEvent.tab();
    expect(screen.getByRole('button', { name: session.name })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledOnce();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Pin session' })).toHaveFocus();
  });

  it('hides the legacy generated title avatar but preserves custom emoji titles', () => {
    const role = { id: 'role', name: 'My', avatar: '🤖', revision: 1 };
    const props = { active: false, status: undefined, onClick: () => {}, onRenamed: () => {} };
    const { rerender } = render(<SessionRow {...props} session={{ ...session, name: '🤖 My', agentProfile: role }} />);
    expect(screen.getByText('My')).toBeVisible();
    expect(screen.queryByText('🤖 My')).not.toBeInTheDocument();
    rerender(<SessionRow {...props} session={{ ...session, name: '🤖 My notes', agentProfile: role }} />);
    expect(screen.getByText('🤖 My notes')).toBeVisible();
  });

  it('archives through the existing service without opening or renaming the chat', async () => {
    const onClick = vi.fn();
    render(<SessionRow session={session} active status={undefined} onClick={onClick} onRenamed={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Rename session' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Archive session' }));
    await waitFor(() => expect(acpArchiveSession).toHaveBeenCalledExactlyOnceWith('rename-fixture'));
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('prevents duplicate requests and allows retry after an archive failure', async () => {
    let rejectArchive!: (reason: Error) => void;
    vi.mocked(acpArchiveSession).mockImplementationOnce(() => new Promise((_, reject) => { rejectArchive = reject; }));
    const onClick = vi.fn();
    render(<SessionRow session={session} active status={undefined} onClick={onClick} onRenamed={vi.fn()} />);
    const archive = screen.getByRole('button', { name: 'Archive session' });
    fireEvent.click(archive);
    fireEvent.click(archive);
    expect(archive).toBeDisabled();
    expect(acpArchiveSession).toHaveBeenCalledOnce();
    rejectArchive(new Error('Archive unavailable'));
    await waitFor(() => expect(archive).toBeEnabled());
    expect(screen.getByText('Original chat')).toBeVisible();
    fireEvent.click(archive);
    await waitFor(() => expect(acpArchiveSession).toHaveBeenCalledTimes(2));
    expect(onClick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Original chat'));
    expect(onClick).toHaveBeenCalledOnce();
  });
  it('keeps the automation clock visible independently of chat activity', () => {
    const base = { session, active: true, hasSchedule: true, onClick: vi.fn(), onRenamed: vi.fn() };
    const view = render(<SessionRow {...base} status={undefined} />);
    expect(screen.getByLabelText('Automation tasks')).toBeVisible();
    for (const status of [
      { streamState: 'loading' as const, hasUnreadActivity: false },
      { streamState: 'streaming' as const, hasUnreadActivity: false },
      { streamState: 'error' as const, hasUnreadActivity: false },
      { streamState: 'idle' as const, hasUnreadActivity: true },
    ]) {
      view.rerender(<SessionRow {...base} status={status} />);
      expect(screen.getByLabelText('Automation tasks')).toBeVisible();
    }
    view.rerender(
      <SessionRow {...base} status={{ streamState: 'idle', hasUnreadActivity: false }} />
    );
    expect(screen.getByLabelText('Automation tasks')).toBeVisible();
    view.rerender(<SessionRow {...base} hasSchedule={false} status={undefined} />);
    expect(screen.queryByLabelText('Automation tasks')).not.toBeInTheDocument();
  });

  it.each(['loading', 'streaming'] as const)('disables archive while the chat is %s', (streamState) => {
    render(
      <SessionRow
        session={session}
        active
        status={{ streamState, hasUnreadActivity: false }}
        onClick={vi.fn()}
        onRenamed={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Archive session' })).toBeDisabled();
  });
});

describe('NavigationHeaderSlot', () => {
  it.each([false, true])('opens a new chat from the brand with native-control inset %s', (needsTrafficLightInset) => {
    const onNewChat = vi.fn();
    render(
      <NavigationHeaderSlot
        onNewChat={onNewChat}
        needsTrafficLightInset={needsTrafficLightInset}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'CodeBuddy' }));
    expect(onNewChat).toHaveBeenCalledOnce();
    expect(screen.queryByRole('group', { name: 'Workspace switcher' })).not.toBeInTheDocument();
  });

});

describe('task-oriented navigation', () => {
  it('places the media library immediately after history', () => {
    expect(
      [...NAV_ITEMS, SETTINGS_NAV_ITEM].map(({ id, path, label }) => ({ id, path, label }))
    ).toEqual([
      { id: 'home', path: '/', label: 'New Task' },
      { id: 'scheduler', path: '/schedules', label: 'Automatic Tasks' },
      { id: 'toolbox', path: '/toolbox', label: 'Toolbox' },
      { id: 'sessions', path: '/sessions', label: 'History' },
      { id: 'media-library', path: '/media-library', label: 'Media Library' },
      { id: 'custom-agents', path: '/custom-agents', label: 'Custom Agents' },
      { id: 'settings', path: '/settings', label: 'Settings' },
    ]);
  });

  it('keeps legacy product terms as search aliases instead of destinations', () => {
    expect(NAV_ITEMS.flatMap((item) => item.searchAliases ?? [])).toEqual(
      expect.arrayContaining(['Scheduler', 'Skills', 'Apps', 'Extensions'])
    );
    expect(NAV_ITEMS.map((item) => item.id)).not.toEqual(
      expect.arrayContaining(['recipes', 'skills', 'apps', 'extensions'])
    );
  });
});

describe('project group label', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('uses the workspace agent avatar instead of a folder', () => {
    const group = { path: 'D:/studio', label: 'Studio', sessions: [{ id: 'role-chat', agentProfile: { id: 'role', name: 'Writer', avatar: '📚', revision: 1 } }] } as never;
    const { container } = render(<ProjectSessionGroup group={group} renderSession={() => <div>Chat</div>} />);
    expect(screen.getByText('📚')).toBeVisible();
    expect(container.querySelector('.lucide-folder')).toBeNull();
  });

  it('updates only the workspace avatar when its current template changes', () => {
    const role = { id: 'role', name: 'Writer', avatar: '📚', revision: 1 };
    const group = { path: 'D:/studio', label: 'Studio', sessions: [{ id: 'role-chat', agentProfile: role }] } as never;
    const child = () => <SessionRow session={{ id: 'role-chat', name: 'Chat', agentProfile: role } as never} active={false} status={undefined} onClick={() => {}} onRenamed={() => {}} />;
    const { rerender } = render(<ProjectSessionGroup group={group} avatars={{ role: '📚' }} renderSession={child} />);
    expect(screen.getAllByText('📚')).toHaveLength(1);
    rerender(<ProjectSessionGroup group={group} avatars={{ role: '🦊' }} renderSession={child} />);
    expect(screen.queryByText('📚')).not.toBeInTheDocument();
    expect(screen.getAllByText('🦊')).toHaveLength(1);
    expect(screen.getByText('Chat')).toBeVisible();
    expect(role.avatar).toBe('📚');
  });

  it('preserves the project directory casing', () => {
    expect(projectGroupLabelClassName.split(' ')).not.toContain('uppercase');
  });

  it('collapses and expands a project chat group', () => {
    const group = {
      path: 'D:\\Code-Agent',
      label: 'Code-Agent',
      sessions: [{ id: 'session-1' }],
    } as never;
    render(<ProjectSessionGroup group={group} renderSession={() => <div>项目分析测试</div>} />);

    const toggle = screen.getByRole('button', { name: 'Code-Agent' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('项目分析测试')).toBeVisible();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('项目分析测试')).not.toBeInTheDocument();
  });

  it('renames the project display label without changing its path', async () => {
    const group = {
      path: 'D:\\Code-Agent',
      label: 'Code-Agent',
      sessions: [{ id: 'session-1' }],
    } as never;
    render(<ProjectSessionGroup group={group} renderSession={() => <div>项目分析测试</div>} />);

    await userEvent.click(screen.getByRole('button', { name: 'Project actions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename project' }));
    const input = screen.getByRole('textbox', { name: 'Project name' });
    fireEvent.change(input, { target: { value: '旗舰项目' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByText('旗舰项目')).toBeVisible();
    expect(screen.getByRole('button', { name: '旗舰项目' })).toHaveAttribute(
      'title',
      'D:\\Code-Agent'
    );
    expect(window.localStorage.getItem(PROJECT_ALIAS_STORAGE_KEY)).toContain('旗舰项目');
  });

  it('restores the folder label when the custom name is cleared', async () => {
    const group = {
      path: 'D:\\Code-Agent',
      label: 'Code-Agent',
      sessions: [{ id: 'session-1' }],
    } as never;
    const { unmount } = render(
      <ProjectSessionGroup group={group} renderSession={() => <div>项目分析测试</div>} />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Project actions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename project' }));
    let input = screen.getByRole('textbox', { name: 'Project name' });
    fireEvent.change(input, { target: { value: '旗舰项目' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    unmount();

    render(<ProjectSessionGroup group={group} renderSession={() => <div>项目分析测试</div>} />);
    expect(screen.getByText('旗舰项目')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Project actions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename project' }));
    input = screen.getByRole('textbox', { name: 'Project name' });
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByText('Code-Agent')).toBeVisible();
    expect(window.localStorage.getItem(PROJECT_ALIAS_STORAGE_KEY)).not.toContain('旗舰项目');
  });
});


it('pins directly with only pin and archive hover actions and preserves title navigation', async () => {
  localStorage.clear();
  const session: SessionListItem = { id: 'pin-fixture', name: 'Pin fixture', workingDir: 'C:/fixture', createdAt: '2026-11-05', updatedAt: '2026-11-05', messageCount: 1 };
  const onClick = vi.fn();
  render(<SessionRow session={session} active status={undefined} onClick={onClick} onRenamed={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'Session actions' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Pin session' }));
  expect(readSessionPins()).toContain(session.id);
  expect(onClick).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText(session.name));
  expect(onClick).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Unpin session' }));
  expect(readSessionPins()).not.toContain(session.id);
});

it('keeps pins in their workspace or task group and preserves recency below them', () => {
  const item = (id: string, day: number, workingDir: string): SessionListItem => ({
    id, name: id, workingDir, createdAt: '2026-11-01', updatedAt: `2026-11-0${day}`, messageCount: 1,
  });
  const result = groupNavigationSessions([
    item('old-project', 1, 'D:/project'), item('new-project', 6, 'D:/project'),
    item('old-task', 1, ''), item('new-task', 6, ''), item('middle-task', 5, ''),
  ], '', ['old-project', 'old-task']);
  expect(result.tasks.map(s => s.id)).toEqual(['old-task', 'new-task', 'middle-task']);
  expect(result.projects[0].sessions.map(s => s.id)).toEqual(['old-project', 'new-project']);
});

it('opens folder actions, pins locally, and creates a chat in the same directory', async () => {
  localStorage.clear();
  const onNewChat = vi.fn();
  const group = { path: 'D:/Project', label: 'Project', sessions: [], lastActivityAt: '' };
  const openFolder = vi.fn().mockResolvedValue(true);
  window.electron.openDirectoryInExplorer = openFolder;
  render(<ProjectSessionGroup group={group} onNewChat={onNewChat} renderSession={() => null} />);
  await userEvent.click(screen.getByRole('button', { name: 'New conversation in project' }));
  expect(onNewChat).toHaveBeenCalledExactlyOnceWith('D:/Project');
  await userEvent.click(screen.getByRole('button', { name: 'Project actions' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Open folder' }));
  expect(openFolder).toHaveBeenCalledExactlyOnceWith('D:/Project');
  expect(screen.getByRole('button', { name: 'Project' })).toHaveAttribute('aria-expanded', 'true');
  await userEvent.click(screen.getByRole('button', { name: 'Project actions' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Pin project' }));
  expect(readProjectPins()).toEqual(['d:\\project']);
  expect(screen.getByRole('button', { name: 'Project' })).toHaveAttribute('aria-expanded', 'true');
});

it('collects all project pages before confirming archive and never archives another project', async () => {
  vi.mocked(acpListSessions).mockResolvedValueOnce({ sessions: [
    { id: 'p1', workingDir: 'D:/Project' }, { id: 'other', workingDir: 'D:/Other' },
  ] as SessionListItem[], nextCursor: 'next' }).mockResolvedValueOnce({ sessions: [
    { id: 'p2', workingDir: 'd:\\project' }, { id: 'archived', workingDir: 'D:/Project', archivedAt: '2026-11-06' },
  ] as SessionListItem[], nextCursor: null });
  vi.mocked(acpArchiveSession).mockReset().mockResolvedValue(undefined);
  render(<ProjectSessionGroup group={{ path: 'D:/Project', label: 'Project', sessions: [], lastActivityAt: '' }} renderSession={() => null} />);
  await userEvent.click(screen.getByRole('button', { name: 'Project actions' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Archive conversations in project' }));
  await screen.findByText(/Archive 2 conversations/);
  expect(acpArchiveSession).not.toHaveBeenCalled();
  expect(acpListSessions).toHaveBeenLastCalledWith('next', undefined, 'unified');
  await userEvent.click(screen.getByRole('button', { name: 'Archive session' }));
  await waitFor(() => expect(acpArchiveSession).toHaveBeenCalledTimes(2));
  expect(vi.mocked(acpArchiveSession).mock.calls.map(args => args[0])).toEqual(['p1', 'p2']);
});
