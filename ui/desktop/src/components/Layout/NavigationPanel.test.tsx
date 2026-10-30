import { fireEvent, render as testingRender, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { NAV_ITEMS, SETTINGS_NAV_ITEM } from '../../hooks/useNavigationItems';
import { PROJECT_ALIAS_STORAGE_KEY } from '../../utils/projectAliases';
import { acpRenameSession, type SessionListItem } from '../../acp/sessions';
import {
  NavigationHeaderSlot,
  ProjectSessionGroup,
  SessionRow,
  projectGroupLabelClassName,
} from './NavigationPanel';

vi.mock('../../acp/sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../acp/sessions')>()),
  acpRenameSession: vi.fn().mockResolvedValue(undefined),
}));

function render(ui: ReactElement) {
  return testingRender(ui, { wrapper: IntlTestWrapper });
}

describe('chat row rename button', () => {
  const session: SessionListItem = {
    id: 'rename-fixture',
    name: 'Original chat',
    workingDir: 'C:/fixture/project',
    createdAt: '2026-10-09',
    updatedAt: '2026-10-09',
    messageCount: 0,
  };

  beforeEach(() => vi.clearAllMocks());

  it('saves through the existing session service without switching chats', async () => {
    const onClick = vi.fn();
    const onRenamed = vi.fn();
    render(
      <SessionRow
        session={session}
        active
        status={undefined}
        onClick={onClick}
        onRenamed={onRenamed}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Rename session' }));
    const input = screen.getByRole('textbox');
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: 'Updated chat' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onRenamed).toHaveBeenCalledOnce());
    expect(acpRenameSession).toHaveBeenCalledExactlyOnceWith('rename-fixture', 'Updated chat');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('cancels edits without saving and leaves normal chat navigation available', () => {
    const onClick = vi.fn();
    render(
      <SessionRow
        session={session}
        active
        status={undefined}
        onClick={onClick}
        onRenamed={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Rename session' }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Discard this' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(acpRenameSession).not.toHaveBeenCalled();
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

  it('keeps the rename entry disabled while the chat is streaming', () => {
    render(
      <SessionRow
        session={session}
        active
        status={{ streamState: 'streaming', hasUnreadActivity: false }}
        onClick={vi.fn()}
        onRenamed={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Rename session' })).toBeDisabled();
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
  it('exposes the five user-facing destinations without Common Tasks', () => {
    expect(
      [...NAV_ITEMS, SETTINGS_NAV_ITEM].map(({ id, path, label }) => ({ id, path, label }))
    ).toEqual([
      { id: 'home', path: '/', label: 'New Task' },
      { id: 'scheduler', path: '/schedules', label: 'Automatic Tasks' },
      { id: 'toolbox', path: '/toolbox', label: 'Toolbox' },
      { id: 'sessions', path: '/sessions', label: 'History' },
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
