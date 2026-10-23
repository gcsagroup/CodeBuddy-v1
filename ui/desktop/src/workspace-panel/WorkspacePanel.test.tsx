import { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { WorkspacePanel, WorkspacePanelContent } from './WorkspacePanel';
import type { PanelRequest } from './workspacePanelTypes';
import type { Message } from '../types/message';
import type { MediaJob } from './WorkspaceGeneration';
import { AppEvents } from '../constants/events';
import { getSessionGoal } from '../acp/goals';
import { OPEN_GOAL_EDITOR } from './goalPanel';
vi.mock('../acp/goals', () => ({ getSessionGoal: vi.fn(), changeSessionGoal: vi.fn() }));
const mediaState = vi.hoisted(() => ({ jobs: [] as MediaJob[] }));
vi.mock('./WorkspaceGeneration', async (original) => ({
  ...(await original<typeof import('./WorkspaceGeneration')>()),
  useMediaJobs: () => ({ jobs: mediaState.jobs, disconnected: false }),
}));

it('opens a goal after expanding a collapsed panel rerenders its parent callback', async () => {
  let resolveGoal!: (goal: Awaited<ReturnType<typeof getSessionGoal>>) => void;
  vi.mocked(getSessionGoal).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveGoal = resolve;
      })
  );
  function Host() {
    const [expanded, setExpanded] = useState(false);
    return (
      <WorkspacePanelContent
        scope={{ sessionId: 'collapsed-goal', root: '' }}
        expanded={expanded}
        width={560}
        onExpandedChange={(value) => setExpanded(value)}
      />
    );
  }
  render(<Host />, { wrapper: IntlTestWrapper });
  fireEvent(window, new CustomEvent(OPEN_GOAL_EDITOR, { detail: { sessionId: 'collapsed-goal' } }));
  resolveGoal({
    id: 'goal',
    revision: 1,
    objective: 'Keep the pending editor request',
    phase: 'paused',
    activation: 'disarmed',
    roundsStarted: 0,
    maxGoalRounds: 256,
  });
  expect(await screen.findByRole('textbox', { name: 'Edit goal' })).toHaveValue(
    'Keep the pending editor request'
  );
});

it('opens one goal editor tab and protects its draft when closing is cancelled', async () => {
  vi.mocked(getSessionGoal).mockResolvedValue({
    id: 'goal',
    revision: 1,
    objective: 'Build a calendar',
    phase: 'paused',
    activation: 'disarmed',
    roundsStarted: 0,
    maxGoalRounds: 256,
  });
  render(
    <WorkspacePanelContent
      scope={{ sessionId: 'goal-panel-test', root: '' }}
      expanded
      width={560}
      onExpandedChange={vi.fn()}
    />,
    { wrapper: IntlTestWrapper }
  );
  const open = () =>
    fireEvent(
      window,
      new CustomEvent(OPEN_GOAL_EDITOR, { detail: { sessionId: 'goal-panel-test' } })
    );
  open();
  const input = await screen.findByRole('textbox', { name: 'Edit goal' });
  fireEvent.change(input, { target: { value: 'Keep my revised goal' } });
  open();
  expect(screen.getAllByRole('tab', { name: /Edit goal/ })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Close Edit goal' }));
  expect(await screen.findByRole('dialog')).toHaveTextContent('Discard unsaved edits');
  fireEvent.click(screen.getByRole('button', { name: 'No' }));
  expect(input).toHaveValue('Keep my revised goal');
});
vi.mock('./WorkspaceSubagent', () => ({
  WorkspaceSubagent: ({ childSessionId }: { childSessionId: string }) => (
    <div>child-conversation:{childSessionId}</div>
  ),
}));
const snapshotMock = vi.hoisted(() => ({
  binding: 'project_container',
  readonlyHistory: false,
  sessionId: 'container',
  root: '/Users/test/Projects',
}));
vi.mock('../acp/chatSessionStore', () => ({
  useAcpChatSessionSnapshot: () => ({
    session: {
      working_dir: snapshotMock.root,
      extension_data: {
        workspaceBinding: snapshotMock.binding,
        readonlyHistory: snapshotMock.readonlyHistory,
      },
    },
  }),
}));
vi.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams({ resumeSessionId: snapshotMock.sessionId })],
}));
vi.mock('./WorkspaceTerminal', () => ({
  WorkspaceTerminal: ({ id }: { id: string }) => <div>terminal:{id}</div>,
}));
it('passes resize intent to the layout owner without imposing a second window clamp', () => {
  const onWidthChange = vi.fn(),
    onChatCollapsedChange = vi.fn(),
    onResetWidth = vi.fn();
  const view = render(
    <WorkspacePanelContent
      scope={{ sessionId: 'resize', root: '' }}
      expanded
      width={900}
      onExpandedChange={vi.fn()}
      onWidthChange={onWidthChange}
      onChatCollapsedChange={onChatCollapsedChange}
      onResetWidth={onResetWidth}
    />,
    { wrapper: IntlTestWrapper }
  );
  expect(screen.getByRole('complementary')).toHaveStyle({ width: '900px' });
  const separator = screen.getByRole('separator');
  fireEvent.keyDown(separator, { key: 'ArrowLeft' });
  expect(onWidthChange).toHaveBeenLastCalledWith(932);
  fireEvent.keyDown(separator, { key: 'Home' });
  expect(onResetWidth).toHaveBeenCalledOnce();
  view.rerender(
    <WorkspacePanelContent
      scope={{ sessionId: 'resize', root: '' }}
      expanded
      width={1200}
      chatCollapsed
      onExpandedChange={vi.fn()}
      onWidthChange={onWidthChange}
      onChatCollapsedChange={onChatCollapsedChange}
    />
  );
  fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowRight' });
  expect(onChatCollapsedChange).toHaveBeenLastCalledWith(false);
});
vi.mock('./WorkspaceBrowser', () => ({
  WorkspaceBrowser: ({ id }: { id: string }) => <div>browser:{id}</div>,
}));
vi.mock('../components/codepro/GitRepositoryPanel', () => ({
  GitRepositoryPanel: ({
    sessionId,
    workingDirectory,
  }: {
    sessionId: string;
    workingDirectory: string;
  }) => (
    <div data-testid="git-scope">
      {sessionId}:{workingDirectory}
    </div>
  ),
}));
vi.mock('../components/MarkdownContent', () => ({
  default: ({ content }: { content: string }) => <pre>{content}</pre>,
}));
const invoke = vi.fn();
vi.mock('../acp/subagentCatalog', () => ({
  readSubagentCatalog: vi.fn(async (sessionId: string) => ({
    sessionId,
    ancestorSessionIds: [],
    children: [
      { id: 'catalog-only-child', createdAt: 1000, mode: 'continuable', label: 'Catalog review' },
    ],
  })),
}));
it('browses the native subagent catalog without a writable root or parent tool receipts', async () => {
  render(
    <WorkspacePanelContent
      scope={{ sessionId: 'catalog-history', root: '' }}
      expanded
      width={560}
      onExpandedChange={vi.fn()}
    />,
    { wrapper: IntlTestWrapper }
  );
  fireEvent.click(screen.getByRole('tab', { name: 'Subagents' }));
  const child = await screen.findByRole('button', { name: 'Catalog review' });
  const avatar = child.querySelector('[data-subagent-avatar]')!;
  const colors = (element: typeof avatar) =>
    [...element.classList].filter((name) => /^(bg-|text-|dark:)/.test(name));
  const childColors = colors(avatar);
  expect(avatar).toHaveAttribute('data-subagent-avatar', 'catalog-only-child');
  fireEvent.click(child);
  expect(screen.getByText('child-conversation:catalog-only-child')).toBeVisible();
  const tabAvatar = screen
    .getByRole('tab', { name: 'Catalog review' })
    .querySelector('[data-subagent-avatar]')!;
  expect(tabAvatar).toHaveAttribute('data-subagent-avatar', 'catalog-only-child');
  expect(colors(tabAvatar)).toEqual(childColors);
  fireEvent(
    window,
    new CustomEvent('codebuddy:open-subagent-catalog', { detail: { parentSessionId: 'foreign' } })
  );
  expect(screen.getByText('child-conversation:catalog-only-child')).toBeVisible();
  fireEvent(
    window,
    new CustomEvent('codebuddy:open-subagent-catalog', {
      detail: { parentSessionId: 'catalog-history' },
    })
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Catalog review' }));
  expect(screen.getAllByRole('tab', { name: 'Catalog review' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Close Catalog review' }));
  expect(invoke).not.toHaveBeenCalled();
});
it('opens historical changes without a writable workspace and keeps file tabs separate by turn', () => {
  const scope = { sessionId: 'readonly-change-history', root: '' };
  render(<WorkspacePanelContent scope={scope} expanded width={560} onExpandedChange={vi.fn()} />, {
    wrapper: IntlTestWrapper,
  });
  fireEvent.click(screen.getByRole('tab', { name: 'Changes' }));
  expect(screen.getByText('No recorded file changes yet.')).toBeVisible();
  fireEvent(
    window,
    new CustomEvent('codebuddy:open-conversation-change', {
      detail: {
        sessionId: 'other',
        turnId: 'first',
        filePath: '/fixture/foreign.py',
      },
    })
  );
  expect(screen.queryByRole('tab', { name: 'foreign.py' })).toBeNull();
  for (const turnId of ['first', 'first', 'second']) {
    fireEvent(
      window,
      new CustomEvent('codebuddy:open-conversation-change', {
        detail: {
          sessionId: scope.sessionId,
          turnId,
          filePath: '/fixture/app.py',
        },
      })
    );
  }
  expect(screen.getAllByRole('tab', { name: 'app.py' })).toHaveLength(2);
  expect(
    screen.getByText('This change is no longer present in the conversation records.')
  ).toBeVisible();
  fireEvent.click(screen.getAllByRole('button', { name: 'Close app.py' })[0]);
  expect(screen.getAllByRole('tab', { name: 'app.py' })).toHaveLength(1);
  expect(invoke).not.toHaveBeenCalled();
});
beforeEach(() => {
  mediaState.jobs = [];
  snapshotMock.binding = 'project_container';
  snapshotMock.readonlyHistory = false;
  snapshotMock.sessionId = 'container';
  snapshotMock.root = '/Users/test/Projects';
  invoke.mockReset();
  Object.assign(window.electron, { workspacePanel: invoke, platform: 'win32' });
  invoke.mockImplementation(async (r: PanelRequest) => {
    if (r.action === 'list')
      return { entries: [{ name: 'note.txt', path: 'note.txt', kind: 'file' }] };
    if (r.action === 'read')
      return { document: { path: 'note.txt', content: 'original', version: 'v1' } };
    if (r.action === 'save')
      return { document: { path: r.path, content: r.content, version: 'v2' } };
    if (r.action === 'terminal-create') return { id: 'pty-1' };
    if (r.action === 'browser-create') return { id: 'web-1' };
    return {};
  });
});
it('closes and reopens generation preview without losing jobs or reopening on progress polls', async () => {
  const job = (id: string): MediaJob => ({
    job_id: id,
    kind: 'image',
    status: 'running',
    created_at: new Date().toISOString(),
    live: { connected: true, step: 1, total: 10 },
  });
  mediaState.jobs = [job('close-a'), job('close-b')];
  const { scope, rerender } = panel();
  expect(await screen.findByRole('tab', { name: 'Generation' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  fireEvent.click(screen.getByRole('button', { name: 'Close Generation' }));
  expect(screen.queryByRole('tab', { name: 'Generation' })).toBeNull();
  const redraw = () =>
    rerender(
      <WorkspacePanelContent scope={scope} expanded width={560} onExpandedChange={vi.fn()} />
    );
  mediaState.jobs = mediaState.jobs.map((job) => ({ ...job, live: { ...job.live, step: 5 } }));
  redraw();
  expect(screen.queryByRole('tab', { name: 'Generation' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Generation' }));
  expect(screen.getByRole('tab', { name: 'Generation' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getAllByRole('progressbar')).toHaveLength(2);
  expect(mediaState.jobs.every((job) => job.status === 'running')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Close Generation' }));
  mediaState.jobs = [...mediaState.jobs, job('close-c')];
  redraw();
  expect(screen.getByRole('tab', { name: 'Generation' })).toHaveAttribute('aria-selected', 'true');
});
function panel(id = globalThis.crypto.randomUUID()) {
  const scope = { sessionId: id, root: 'D:\\fixture' };
  const element = (
    <WorkspacePanelContent key={id} scope={scope} expanded width={560} onExpandedChange={vi.fn()} />
  );
  return { ...render(element, { wrapper: IntlTestWrapper }), scope, element };
}

it('isolates workbench tabs and drafts on route and workspace changes while keeping the main subtree mounted', async () => {
  const first = globalThis.crypto.randomUUID(),
    second = globalThis.crypto.randomUUID();
  snapshotMock.binding = 'writable_project';
  snapshotMock.sessionId = first;
  snapshotMock.root = 'D:/fixture/first';
  const tree = () => (
    <>
      <input aria-label="Main conversation draft" defaultValue="" />
      <WorkspacePanel expanded width={560} onExpandedChange={vi.fn()} />
    </>
  );
  const view = render(tree(), { wrapper: IntlTestWrapper });
  fireEvent.change(screen.getByLabelText('Main conversation draft'), {
    target: { value: 'Keep the main conversation mounted' },
  });
  const openDraft = async (id: string, draft: string) => {
    fireEvent(
      window,
      new CustomEvent('codebuddy:open-workspace-file', {
        detail: { sessionId: id, filePath: 'note.txt' },
      })
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'File editor' }), {
      target: { value: draft },
    });
  };
  const openChild = (id: string, child: string) =>
    fireEvent(
      window,
      new CustomEvent('codebuddy:open-subagent-conversation', {
        detail: { parentSessionId: id, childSessionId: child, title: child },
      })
    );
  const switchTo = (id: string, root: string) => {
    snapshotMock.sessionId = id;
    snapshotMock.root = root;
    view.rerender(tree());
    expect(screen.getByLabelText('Main conversation draft')).toHaveValue(
      'Keep the main conversation mounted'
    );
  };

  await openDraft(first, 'first chat draft');
  openChild(first, 'first-child');
  expect(screen.getByText('child-conversation:first-child')).toBeVisible();

  switchTo(second, 'D:/fixture/second');
  expect(screen.queryByRole('tab', { name: 'first-child' })).toBeNull();
  expect(screen.queryByRole('tab', { name: /note\.txt/ })).toBeNull();
  expect(screen.queryByText('child-conversation:first-child')).toBeNull();
  await openDraft(second, 'second chat draft');
  openChild(second, 'second-child');

  switchTo(first, 'D:/fixture/first');
  expect(screen.getByText('child-conversation:first-child')).toBeVisible();
  expect(screen.queryByRole('tab', { name: 'second-child' })).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: /note\.txt/ }));
  expect(screen.getByRole('textbox', { name: 'File editor' })).toHaveValue('first chat draft');

  switchTo(first, 'D:/fixture/rebound');
  expect(screen.queryByRole('tab', { name: /note\.txt|first-child/ })).toBeNull();
  openChild(first, 'rebound-child');
  expect(screen.getByText('child-conversation:rebound-child')).toBeVisible();

  switchTo(second, 'D:/fixture/second');
  expect(screen.getByText('child-conversation:second-child')).toBeVisible();
  expect(screen.queryByRole('tab', { name: 'rebound-child' })).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: /note\.txt/ }));
  expect(screen.getByRole('textbox', { name: 'File editor' })).toHaveValue('second chat draft');
});

it('invalidates retired child views after a confirmed edit, preserving file drafts and other chats', async () => {
  const { scope } = panel();
  fireEvent(
    window,
    new CustomEvent('codebuddy:open-workspace-file', {
      detail: { sessionId: scope.sessionId, filePath: 'note.txt' },
    })
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'File editor' }), {
    target: { value: 'unsaved user draft' },
  });
  fireEvent(
    window,
    new CustomEvent('codebuddy:open-subagent-conversation', {
      detail: { parentSessionId: scope.sessionId, childSessionId: 'old-child', title: 'Old child' },
    })
  );
  expect(screen.getByText('child-conversation:old-child')).toBeVisible();
  fireEvent(
    window,
    new CustomEvent(AppEvents.SESSION_CONVERSATION_CHANGED, { detail: { sessionId: 'other-chat' } })
  );
  expect(screen.getByText('child-conversation:old-child')).toBeVisible();
  fireEvent(
    window,
    new CustomEvent(AppEvents.SESSION_CONVERSATION_CHANGED, {
      detail: { sessionId: scope.sessionId },
    })
  );
  expect(screen.queryByRole('tab', { name: 'Old child' })).toBeNull();
  expect(await screen.findByRole('button', { name: 'Catalog review' })).toBeVisible();
  fireEvent.click(screen.getByRole('tab', { name: 'note.txt ●' }));
  expect(screen.getByRole('textbox', { name: 'File editor' })).toHaveValue('unsaved user draft');
});

it('opens verified document entries as file information while preserving an edited file tab', async () => {
  const { scope } = panel();
  fireEvent(
    window,
    new CustomEvent('codebuddy:open-workspace-file', {
      detail: { sessionId: scope.sessionId, filePath: 'note.txt' },
    })
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'File editor' }), {
    target: { value: 'unsaved user draft' },
  });
  invoke.mockImplementation(async (r: PanelRequest) =>
    r.action === 'inspect' ? { file: { path: r.path, size: 35000, openExternally: true } } : {}
  );
  fireEvent(
    window,
    new CustomEvent('codebuddy:open-workspace-file', {
      detail: { sessionId: 'foreign', filePath: 'ignore.docx' },
    })
  );
  expect(screen.queryByRole('tab', { name: 'ignore.docx' })).toBeNull();
  fireEvent(
    window,
    new CustomEvent('codebuddy:open-workspace-file', {
      detail: { sessionId: scope.sessionId, filePath: 'report.docx' },
    })
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Open in default application' }));
  expect(invoke).toHaveBeenCalledWith({ scope, action: 'open-external', path: 'report.docx' });
  fireEvent.click(screen.getByRole('tab', { name: /note.txt/ }));
  expect(screen.getByRole('textbox', { name: 'File editor' })).toHaveValue('unsaved user draft');
});
function fileOperation(
  id: string,
  name: string,
  path: string,
  before = 'old\n',
  after = 'new\n'
): Message[] {
  const metadata = { userVisible: true, agentVisible: true };
  return [
    {
      id: `request:${id}`,
      created: 1,
      role: 'assistant',
      metadata,
      content: [
        {
          type: 'toolRequest',
          id,
          metadata: { extensionName: 'harness' },
          toolCall: { status: 'success', value: { name, arguments: { path } } },
        },
      ],
    },
    ...(name === 'read'
      ? []
      : [
          {
            id: `response:${id}`,
            created: 2,
            role: 'user' as const,
            metadata,
            content: [
              {
                type: 'toolResponse' as const,
                id,
                toolResult: {
                  status: 'success',
                  value: { content: [], structuredContent: { path, before, after } },
                },
              },
            ],
          },
        ]),
  ];
}
it('opens each write receipt in a separate historical tab without reading today’s file', () => {
  const scope = { sessionId: 'exact-file-operation', root: 'D:\\fixture' };
  const messages = [
    ...fileOperation('edit-a', 'write', 'app.py', 'old\n', 'first\n'),
    ...fileOperation('edit-b', 'edit', 'app.py', 'first\n', 'second\n'),
  ];
  render(
    <WorkspacePanelContent
      scope={scope}
      messages={messages}
      expanded
      width={560}
      onExpandedChange={vi.fn()}
    />,
    { wrapper: IntlTestWrapper }
  );
  const open = (toolCallId: string) =>
    fireEvent(
      window,
      new CustomEvent('codebuddy:open-conversation-change', {
        detail: { sessionId: scope.sessionId, toolCallId, filePath: 'app.py' },
      })
    );
  open('edit-a');
  expect(screen.getByText('+first')).toBeVisible();
  expect(screen.queryByText('+second')).toBeNull();
  open('edit-b');
  expect(screen.getByText('+second')).toBeVisible();
  expect(screen.queryByText('-old')).toBeNull();
  open('edit-a');
  expect(screen.getByText('+first')).toBeVisible();
  expect(screen.getAllByRole('tab', { name: 'app.py' })).toHaveLength(2);
  expect(invoke).not.toHaveBeenCalled();
});

it('opens read targets through the existing file tab and reuses absolute and relative identities', async () => {
  const scope = { sessionId: 'read-file-operation', root: 'D:\\fixture' };
  render(
    <WorkspacePanelContent
      scope={scope}
      messages={fileOperation('read-a', 'read', 'D:\\fixture\\note.txt')}
      expanded
      width={560}
      onExpandedChange={vi.fn()}
    />,
    { wrapper: IntlTestWrapper }
  );
  fireEvent(
    window,
    new CustomEvent('codebuddy:open-conversation-change', {
      detail: {
        sessionId: scope.sessionId,
        toolCallId: 'read-a',
        filePath: 'D:\\fixture\\note.txt',
      },
    })
  );
  expect(await screen.findByRole('tab', { name: 'note.txt' })).toBeVisible();
  expect(invoke).toHaveBeenCalledWith({ scope, action: 'read', path: 'D:\\fixture\\note.txt' });
  invoke.mockClear();
  fireEvent(
    window,
    new CustomEvent('codebuddy:open-conversation-change', {
      detail: { sessionId: scope.sessionId, toolCallId: 'read-a', filePath: 'note.txt' },
    })
  );
  expect(screen.getAllByRole('tab', { name: 'note.txt' })).toHaveLength(1);
  expect(invoke).not.toHaveBeenCalled();
});

it('rejects an unknown call or a mismatched path instead of opening an arbitrary current file', () => {
  const scope = { sessionId: 'invalid-file-operation', root: 'D:\\fixture' };
  render(
    <WorkspacePanelContent
      scope={scope}
      messages={fileOperation('read-a', 'read', 'note.txt')}
      expanded
      width={560}
      onExpandedChange={vi.fn()}
    />,
    { wrapper: IntlTestWrapper }
  );
  for (const target of [
    { toolCallId: 'read-a', filePath: 'other.txt' },
    { toolCallId: 'unknown', filePath: 'note.txt' },
  ]) {
    fireEvent(
      window,
      new CustomEvent('codebuddy:open-conversation-change', {
        detail: { sessionId: scope.sessionId, ...target },
      })
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This change is no longer present in the conversation records.'
    );
  }
  expect(invoke).not.toHaveBeenCalled();
});
async function edit() {
  fireEvent.click(screen.getByRole('button', { name: /Workspace files\s*Browse/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'note.txt' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'File editor' }), {
    target: { value: 'local draft' },
  });
}
it('opens only this parent child in the existing panel and reuses its tab', async () => {
  const { scope } = panel();
  fireEvent(
    window,
    new CustomEvent('codebuddy:open-subagent-conversation', {
      detail: { parentSessionId: 'other-parent', childSessionId: 'foreign', title: 'Foreign' },
    })
  );
  expect(screen.queryByText('child-conversation:foreign')).not.toBeInTheDocument();
  fireEvent(
    window,
    new CustomEvent('codebuddy:open-subagent-conversation', {
      detail: {
        parentSessionId: scope.sessionId,
        childSessionId: 'child-1',
        title: 'Read-only review',
      },
    })
  );
  expect(screen.getByText('child-conversation:child-1')).toBeVisible();
  // Repeated clicks activate the same tab. Closing it must not close a runtime
  // terminal/browser or cancel the child Agent.
  fireEvent.click(screen.getAllByTitle('Start')[0]);
  fireEvent(
    window,
    new CustomEvent('codebuddy:open-subagent-conversation', {
      detail: {
        parentSessionId: scope.sessionId,
        childSessionId: 'child-1',
        title: 'Read-only review',
      },
    })
  );
  expect(screen.getAllByRole('tab', { name: 'Read-only review' })).toHaveLength(1);
  const before = invoke.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Close Read-only review' }));
  expect(screen.queryByText('child-conversation:child-1')).not.toBeInTheDocument();
  expect(invoke.mock.calls.length).toBe(before);
});
it('removes Git and review launchers while keeping files and conversation changes', () => {
  panel();
  expect(screen.queryByRole('tab', { name: 'Git and review' })).toBeNull();
  expect(screen.queryByRole('button', { name: /Git and review\s*Inspect/ })).toBeNull();
  expect(screen.getByRole('tab', { name: 'Workspace files' })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Changes' })).toBeInTheDocument();
});
it('keeps removed Git entries absent before a session is bound', () => {
  render(
    <WorkspacePanelContent
      scope={{ sessionId: '', root: '' }}
      expanded
      width={560}
      onExpandedChange={vi.fn()}
    />,
    { wrapper: IntlTestWrapper }
  );
  expect(screen.queryByRole('tab', { name: 'Git and review' })).toBeNull();
  expect(screen.queryByRole('button', { name: /Git and review\s*Inspect/ })).toBeNull();
  expect(screen.queryByTestId('git-scope')).toBeNull();
});
it('shows the three entries and saves an edit with the session scope and original version', async () => {
  const { scope } = panel();
  await edit();
  fireEvent.click(screen.getByRole('button', { name: 'Save file (Ctrl+S)' }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith({
      scope,
      action: 'save',
      path: 'note.txt',
      content: 'local draft',
      version: 'v1',
    })
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save file (Ctrl+S)' })).toBeDisabled()
  );
});
it('keeps the draft after a disk conflict', async () => {
  panel();
  await edit();
  invoke.mockRejectedValueOnce(new Error('File changed on disk'));
  fireEvent.click(screen.getByRole('button', { name: 'Save file (Ctrl+S)' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('File changed on disk');
  expect(screen.getByRole('textbox', { name: 'File editor' })).toHaveValue('local draft');
});
it('offers a full width preview, optional tree and wrapping without losing edits', async () => {
  panel();
  await edit();
  expect(screen.queryByRole('region', { name: 'Workspace file tree' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Workspace file tree' }));
  expect(screen.getByRole('region', { name: 'Workspace file tree' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Wrap lines' }));
  expect(screen.getByRole('textbox', { name: 'File editor' })).toHaveAttribute('wrap', 'soft');
  fireEvent.click(screen.getByRole('button', { name: 'Workspace file tree' }));
  expect(screen.getByRole('textbox', { name: 'File editor' })).toHaveValue('local draft');
});
it('retains drafts across a session switch without exposing them in the next session', async () => {
  const first = panel();
  await edit();
  first.unmount();
  const second = panel();
  expect(screen.queryByDisplayValue('local draft')).toBeNull();
  second.unmount();
  render(first.element, { wrapper: IntlTestWrapper });
  expect(screen.getByRole('textbox', { name: 'File editor' })).toHaveValue('local draft');
});
it('creates separate scoped terminal and browser tabs', async () => {
  const { scope } = panel();
  fireEvent.click(screen.getByRole('button', { name: /New terminal\s*Run/ }));
  expect(await screen.findByText('terminal:pty-1')).toBeVisible();
  fireEvent.click(screen.getAllByTitle('Start')[0]);
  fireEvent.click(screen.getByRole('button', { name: /Browser\s*Browse/ }));
  expect(await screen.findByText('browser:web-1')).toBeVisible();
  expect(invoke).toHaveBeenCalledWith({ scope, action: 'terminal-create' });
  expect(invoke).toHaveBeenCalledWith({ scope, action: 'browser-create' });
});
it('shows disabled entries before a session is selected', () => {
  render(
    <WorkspacePanelContent
      scope={{ sessionId: '', root: '' }}
      expanded
      width={560}
      onExpandedChange={vi.fn()}
    />,
    { wrapper: IntlTestWrapper }
  );
  expect(screen.getByRole('button', { name: /New terminal\s*Run/ })).toBeDisabled();
  expect(screen.getByRole('button', { name: /Browser\s*Browse/ })).toBeDisabled();
});

it('can collapse and reopen the panel before selecting a workspace', () => {
  function InitialWorkspacePanel() {
    const [expanded, setExpanded] = useState(true);
    return (
      <WorkspacePanelContent
        scope={{ sessionId: '', root: '' }}
        expanded={expanded}
        width={560}
        onExpandedChange={setExpanded}
      />
    );
  }
  render(<InitialWorkspacePanel />, { wrapper: IntlTestWrapper });
  fireEvent.click(screen.getByTitle('Collapse panel'));
  expect(screen.queryByRole('complementary')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open workspace panel' }));
  expect(screen.getByRole('complementary')).toBeVisible();
});

it('uses the shared confirmation dialog and preserves drafts when closing is cancelled', async () => {
  panel();
  await edit();
  fireEvent.click(screen.getByRole('button', { name: 'Close note.txt' }));
  expect(await screen.findByRole('dialog')).toHaveTextContent('Discard unsaved edits');
  fireEvent.click(screen.getByRole('button', { name: 'No' }));
  expect(screen.getByRole('textbox', { name: 'File editor' })).toHaveValue('local draft');
  fireEvent.click(screen.getByRole('button', { name: 'Close note.txt' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Yes' }));
  await waitFor(() => expect(screen.queryByRole('textbox', { name: 'File editor' })).toBeNull());
});
it('stops a terminal only after confirmation', async () => {
  const { scope } = panel();
  fireEvent.click(screen.getByRole('button', { name: /New terminal\s*Run/ }));
  await screen.findByText('terminal:pty-1');
  fireEvent.click(screen.getByRole('button', { name: 'Close New terminal 1' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Yes' }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith({ scope, action: 'terminal-close', id: 'pty-1' })
  );
});

it('shows Mac shortcuts and opens the browser when Option changes the key character', async () => {
  Object.assign(window.electron, { platform: 'darwin' });
  const { scope } = panel();
  expect(screen.getByText('⌘+P')).toBeVisible();
  expect(screen.getByText('⌘+⌥+B')).toBeVisible();
  fireEvent.keyDown(window, { key: '∫', code: 'KeyB', metaKey: true, altKey: true });
  expect(await screen.findByText('browser:web-1')).toBeVisible();
  expect(invoke).toHaveBeenCalledWith({ scope, action: 'browser-create' });
});

it('saves the Mac editor draft with Command+S', async () => {
  Object.assign(window.electron, { platform: 'darwin' });
  const { scope } = panel();
  await edit();
  expect(screen.getByRole('button', { name: 'Save file (⌘+S)' })).toBeEnabled();
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'File editor' }), {
    key: 's',
    code: 'KeyS',
    metaKey: true,
  });
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith({
      scope,
      action: 'save',
      path: 'note.txt',
      content: 'local draft',
      version: 'v1',
    })
  );
});

it('does not claim modified file shortcuts or IME composition', async () => {
  panel();
  await edit();
  invoke.mockClear();
  fireEvent.keyDown(window, { key: 's', ctrlKey: true, shiftKey: true });
  fireEvent.keyDown(window, { key: 's', ctrlKey: true, altKey: true });
  fireEvent.keyDown(window, { key: 's', ctrlKey: true, isComposing: true });
  expect(invoke).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'File editor' })).toHaveValue('local draft');
});

it('does not expose executable workspace tools for imported readonly history', () => {
  snapshotMock.binding = 'writable_project';
  snapshotMock.readonlyHistory = true;
  render(<WorkspacePanel expanded width={560} onExpandedChange={vi.fn()} />, {
    wrapper: IntlTestWrapper,
  });
  for (const name of [/Workspace files.*Browse/, /New terminal.*Run/, /Browser.*Browse/]) {
    const entry = screen.getByRole('button', { name });
    expect(entry).toBeDisabled();
    fireEvent.click(entry);
  }
  expect(invoke).not.toHaveBeenCalled();
});

it.each(['project_container', 'root_container', 'unbound'])(
  'does not open parent tools for a %s binding',
  (binding) => {
    snapshotMock.binding = binding;
    render(<WorkspacePanel expanded width={560} onExpandedChange={vi.fn()} />, {
      wrapper: IntlTestWrapper,
    });
    const files = screen.getByRole('button', { name: /Workspace files.*Browse/ });
    expect(files).toBeDisabled();
    fireEvent.click(files);
    expect(invoke).not.toHaveBeenCalled();
  }
);

it('shows a binary document as read-only instead of an IPC error', async () => {
  invoke.mockImplementation(async (r: PanelRequest) => {
    if (r.action === 'list')
      return { entries: [{ name: 'school.db', path: 'school.db', kind: 'file' }] };
    if (r.action === 'read')
      return { document: { path: 'school.db', content: '', version: 'db1', binary: true } };
    return {};
  });
  panel();
  fireEvent.click(screen.getByRole('button', { name: /Workspace files\s*Browse/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'school.db' }));
  expect(await screen.findByRole('status')).toHaveTextContent('school.db is a binary file');
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});
it('clears a previous error when returning to an existing file tab, keeping its draft', async () => {
  panel();
  await edit();
  invoke.mockRejectedValueOnce(new Error('File changed on disk'));
  fireEvent.click(screen.getByRole('button', { name: 'Save file (Ctrl+S)' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getAllByTitle('Start')[0]);
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: /^note\.txt/ }));
  expect(screen.getByRole('textbox', { name: 'File editor' })).toHaveValue('local draft');
});

it('opens a local video in the right panel with playback controls and no editing controls', async () => {
  invoke.mockImplementation(async (request: PanelRequest) =>
    request.action === 'read'
      ? {
          document: {
            path: 'clip.mp4',
            content: '',
            version: '',
            media: {
              kind: 'video',
              mimeType: 'video/mp4',
              url: 'codebuddy-media://preview/token',
            },
          },
        }
      : { entries: [] }
  );
  const view = render(
    <WorkspacePanelContent
      scope={{ sessionId: 'media-panel', root: 'D:\\fixture' }}
      expanded
      width={600}
      onExpandedChange={vi.fn()}
    />,
    { wrapper: IntlTestWrapper }
  );
  fireEvent(
    window,
    new CustomEvent('codebuddy:open-workspace-file', {
      detail: { sessionId: 'media-panel', filePath: 'clip.mp4' },
    })
  );
  await waitFor(() => expect(view.container.querySelector('video')).toHaveAttribute('controls'));
  expect(view.container.querySelector('video')).toHaveAttribute(
    'src',
    'codebuddy-media://preview/token'
  );
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  fireEvent.error(view.container.querySelector('video')!);
  expect(screen.getByRole('status')).toHaveTextContent('Media could not be loaded');
  fireEvent.click(screen.getByRole('button', { name: 'Reload file from disk' }));
  await waitFor(() => expect(view.container.querySelector('video')).toHaveAttribute('controls'));
});
