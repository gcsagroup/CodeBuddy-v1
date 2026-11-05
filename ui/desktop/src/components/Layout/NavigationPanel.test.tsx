import { fireEvent, render as testingRender, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { NAV_ITEMS, SETTINGS_NAV_ITEM } from '../../hooks/useNavigationItems';
import { PROJECT_ALIAS_STORAGE_KEY } from '../../utils/projectAliases';
import { acpArchiveSession, type SessionListItem } from '../../acp/sessions';
import {
  NavigationHeaderSlot,
  ProjectSessionGroup,
  SessionRow,
  projectGroupLabelClassName,
} from './NavigationPanel';

vi.mock('../../acp/sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../acp/sessions')>()),
  acpArchiveSession: vi.fn().mockResolvedValue(undefined),
}));

function render(ui: ReactElement) {
  return testingRender(ui, { wrapper: IntlTestWrapper });
}

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
  it('opens a new chat from the brand while unified mode hides the workspace switcher', () => {
    const onNewChat = vi.fn();
    render(
      <NavigationHeaderSlot
        workspaceMode="codepro"
        onWorkspaceModeChange={vi.fn()}
        unifiedMode
        onNewChat={onNewChat}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'CodeBuddy' }));
    expect(onNewChat).toHaveBeenCalledOnce();
    expect(screen.queryByRole('group', { name: 'Workspace switcher' })).not.toBeInTheDocument();
  });

  it('keeps the brand action available alongside the workspace switcher', () => {
    render(
      <NavigationHeaderSlot
        workspaceMode="codepro"
        onWorkspaceModeChange={vi.fn()}
        unifiedMode={false}
        onNewChat={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'CodeBuddy' })).toBeVisible();
    expect(screen.getByRole('group', { name: 'Workspace switcher' })).toBeInTheDocument();
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

  it('renames the project display label without changing its path', () => {
    const group = {
      path: 'D:\\Code-Agent',
      label: 'Code-Agent',
      sessions: [{ id: 'session-1' }],
    } as never;
    render(<ProjectSessionGroup group={group} renderSession={() => <div>项目分析测试</div>} />);

    fireEvent.click(screen.getByRole('button', { name: 'Rename project' }));
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

  it('restores the folder label when the custom name is cleared', () => {
    const group = {
      path: 'D:\\Code-Agent',
      label: 'Code-Agent',
      sessions: [{ id: 'session-1' }],
    } as never;
    const { unmount } = render(
      <ProjectSessionGroup group={group} renderSession={() => <div>项目分析测试</div>} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Rename project' }));
    let input = screen.getByRole('textbox', { name: 'Project name' });
    fireEvent.change(input, { target: { value: '旗舰项目' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    unmount();

    render(<ProjectSessionGroup group={group} renderSession={() => <div>项目分析测试</div>} />);
    expect(screen.getByText('旗舰项目')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Rename project' }));
    input = screen.getByRole('textbox', { name: 'Project name' });
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByText('Code-Agent')).toBeVisible();
    expect(window.localStorage.getItem(PROJECT_ALIAS_STORAGE_KEY)).not.toContain('旗舰项目');
  });
});
