import { fireEvent, render as testingRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { CodeProTaskPanel } from './CodeProTaskPanel';

function render(ui: ReactElement) {
  return testingRender(ui, { wrapper: IntlTestWrapper });
}

const mockState = vi.hoisted(() => ({
  sessionId: '',
  snapshot: undefined as
    | undefined
    | {
        chatState: string;
        messages: Array<Record<string, unknown>>;
        progressMessage: string;
        session?: { working_dir: string };
      },
}));

const ci = vi.hoisted(() => ({
  load: vi.fn(),
  artifacts: vi.fn(),
  preview: vi.fn(),
  rerun: vi.fn(),
  cancelPreview: vi.fn(),
  cancel: vi.fn(),
  workflowCatalog: vi.fn(),
  workflowPreview: vi.fn(),
  workflowDispatch: vi.fn(),
}));

const githubDelivery = vi.hoisted(() => ({
  status: vi.fn(),
  preview: vi.fn(),
  create: vi.fn(),
  previewState: vi.fn(),
  changeState: vi.fn(),
  previewContent: vi.fn(),
  updateContent: vi.fn(),
}));

const gitPanel = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));

vi.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams({ resumeSessionId: mockState.sessionId })],
}));

vi.mock('../../acp/chatSessionStore', () => ({
  useAcpChatSessionSnapshot: () => mockState.snapshot,
}));

vi.mock('../../acp/githubCi', () => ({
  acpGetGitHubCiStatus: ci.load,
  acpGetGitHubCiArtifacts: ci.artifacts,
  acpPreviewGitHubCiRerun: ci.preview,
  acpRerunFailedGitHubCiJobs: ci.rerun,
  acpPreviewGitHubCiCancel: ci.cancelPreview,
  acpCancelGitHubCiRun: ci.cancel,
  acpGetGitHubWorkflowDispatchCatalog: ci.workflowCatalog,
  acpPreviewGitHubWorkflowDispatch: ci.workflowPreview,
  acpDispatchGitHubWorkflow: ci.workflowDispatch,
}));

vi.mock('../../acp/githubPullRequests', () => ({
  acpGitHubDeliveryStatus: githubDelivery.status,
  acpPreviewGitHubPullRequest: githubDelivery.preview,
  acpCreateGitHubPullRequest: githubDelivery.create,
  acpPreviewGitHubPullRequestState: githubDelivery.previewState,
  acpChangeGitHubPullRequestState: githubDelivery.changeState,
  acpPreviewGitHubPullRequestContent: githubDelivery.previewContent,
  acpUpdateGitHubPullRequestContent: githubDelivery.updateContent,
}));

vi.mock('./GitRepositoryPanel', async () => {
  const { useEffect } = await import('react');
  return {
    GitRepositoryPanel: () => {
      useEffect(() => {
        gitPanel.mounts += 1;
        return () => {
          gitPanel.unmounts += 1;
        };
      }, []);
      return <div>Git repository sentinel</div>;
    },
  };
});

describe('CodeProTaskPanel resizing', () => {
  beforeEach(() => {
    mockState.sessionId = '';
    mockState.snapshot = undefined;
    ci.preview.mockReset();
    githubDelivery.status.mockReset().mockResolvedValue({
      cliStatus: 'unavailable',
      requiredChecks: [],
    });
    githubDelivery.preview.mockReset();
    githubDelivery.create.mockReset();
    gitPanel.mounts = 0;
    gitPanel.unmounts = 0;
    ci.artifacts.mockReset();
    ci.rerun.mockReset();
    ci.cancelPreview.mockReset();
    ci.cancel.mockReset();
    ci.workflowPreview.mockReset();
    ci.workflowDispatch.mockReset();
    ci.workflowCatalog.mockReset().mockResolvedValue({ workflows: [] });
    ci.load.mockReset().mockResolvedValue({
      repositoryOwner: 'octo',
      repositoryName: 'demo',
      repositoryUrl: 'https://github.com/octo/demo',
      branch: 'main',
      headSha: '1'.repeat(40),
      workingTreeDirty: false,
      aggregateStatus: 'success',
      totalCount: 0,
      truncated: false,
      runs: [],
    });
  });

  it('keeps the collapsed panel entry at least 36 pixels square', () => {
    render(
      <CodeProTaskPanel
        expanded={false}
        onExpandedChange={vi.fn()}
        onWidthChange={vi.fn()}
        width={340}
      />
    );

    expect(screen.getByRole('button', { name: 'Open CodePro task panel' })).toHaveClass(
      'h-9',
      'w-9'
    );
  });

  it('opens and collapses once from native keyboard activation', async () => {
    const user = userEvent.setup();
    const onExpandedChange = vi.fn();
    const view = render(
      <CodeProTaskPanel
        expanded={false}
        onExpandedChange={onExpandedChange}
        onWidthChange={vi.fn()}
        width={340}
      />
    );

    screen.getByRole('button', { name: 'Open CodePro task panel' }).focus();
    await user.keyboard('{Enter}');
    expect(onExpandedChange).toHaveBeenLastCalledWith(true);

    view.rerender(
      <CodeProTaskPanel
        expanded
        onExpandedChange={onExpandedChange}
        onWidthChange={vi.fn()}
        width={340}
      />
    );
    screen.getByRole('button', { name: 'Collapse CodePro task panel' }).focus();
    await user.keyboard(' ');
    expect(onExpandedChange).toHaveBeenLastCalledWith(false);
    expect(onExpandedChange).toHaveBeenCalledTimes(2);
  });

  it('keeps the active Git workflow mounted while the task panel is collapsed', async () => {
    const user = userEvent.setup();
    mockState.sessionId = 'session-git';
    mockState.snapshot = {
      chatState: 'idle',
      messages: [],
      progressMessage: '',
      session: { working_dir: 'D:\\project' },
    };
    const onExpandedChange = vi.fn();
    const view = render(
      <CodeProTaskPanel
        expanded
        onExpandedChange={onExpandedChange}
        onWidthChange={vi.fn()}
        width={340}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Git' }));
    expect(screen.getByText('Git repository sentinel')).toBeVisible();
    expect(gitPanel.mounts).toBe(1);

    view.rerender(
      <CodeProTaskPanel
        expanded={false}
        onExpandedChange={onExpandedChange}
        onWidthChange={vi.fn()}
        width={340}
      />
    );
    expect(screen.getByRole('button', { name: 'Open CodePro task panel' })).toBeVisible();
    expect(screen.getByText('Git repository sentinel').closest('aside')).toHaveClass('hidden');
    expect(screen.getByText('Git repository sentinel').closest('aside')).toHaveAttribute(
      'aria-hidden',
      'true'
    );
    expect(gitPanel.unmounts).toBe(0);

    view.rerender(
      <CodeProTaskPanel
        expanded
        onExpandedChange={onExpandedChange}
        onWidthChange={vi.fn()}
        width={340}
      />
    );
    expect(screen.getByText('Git repository sentinel')).toBeVisible();
    expect(gitPanel.mounts).toBe(1);
  });

  it('opens the Pull Request workflow for the current session directory', async () => {
    const user = userEvent.setup();
    mockState.sessionId = 'session-pr';
    mockState.snapshot = {
      chatState: 'idle',
      messages: [],
      progressMessage: '',
      session: { working_dir: 'D:\\project' },
    };
    render(
      <CodeProTaskPanel expanded onExpandedChange={vi.fn()} onWidthChange={vi.fn()} width={340} />
    );

    await user.click(screen.getByRole('button', { name: 'Pull Request' }));
    expect(screen.getByRole('heading', { name: 'Delivery' })).toBeVisible();
    await waitFor(() =>
      expect(githubDelivery.status).toHaveBeenCalledWith({ workingDir: 'D:\\project' })
    );
    expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument();
  });

  it('opens CI status for the current session directory', async () => {
    const user = userEvent.setup();
    mockState.sessionId = 'session-ci';
    mockState.snapshot = {
      chatState: 'idle',
      messages: [],
      progressMessage: '',
      session: { working_dir: 'D:\\project' },
    };
    render(
      <CodeProTaskPanel expanded onExpandedChange={vi.fn()} onWidthChange={vi.fn()} width={340} />
    );

    await user.click(screen.getByRole('button', { name: 'CI' }));

    expect(screen.getByRole('heading', { name: 'Continuous integration' })).toBeVisible();
    await waitFor(() => expect(ci.load).toHaveBeenCalledWith({ workingDir: 'D:\\project' }));
  });

  it('lets keyboard users widen the panel from its left resize handle', () => {
    const onWidthChange = vi.fn();

    render(
      <CodeProTaskPanel
        expanded
        onExpandedChange={vi.fn()}
        onWidthChange={onWidthChange}
        width={320}
      />
    );

    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize task panel' }), {
      key: 'ArrowLeft',
    });

    expect(screen.getByRole('separator', { name: 'Resize task panel' })).toHaveAttribute(
      'aria-valuemin',
      '320'
    );
    expect(onWidthChange).toHaveBeenCalledWith(352);
  });

  it('resets the panel to its default width on a double click', () => {
    const onWidthChange = vi.fn();

    render(
      <CodeProTaskPanel
        expanded
        onExpandedChange={vi.fn()}
        onWidthChange={onWidthChange}
        width={560}
      />
    );

    fireEvent.doubleClick(screen.getByRole('separator', { name: 'Resize task panel' }));

    expect(onWidthChange).toHaveBeenCalledWith(340);
  });

  it('resets the panel to its default width with the Home key', () => {
    const onWidthChange = vi.fn();

    render(
      <CodeProTaskPanel
        expanded
        onExpandedChange={vi.fn()}
        onWidthChange={onWidthChange}
        width={420}
      />
    );

    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize task panel' }), {
      key: 'Home',
    });

    expect(onWidthChange).toHaveBeenCalledWith(340);
  });

  it('disables the files tab when the current turn has no file evidence', () => {
    render(
      <CodeProTaskPanel expanded onExpandedChange={vi.fn()} onWidthChange={vi.fn()} width={340} />
    );

    expect(screen.getByRole('button', { name: 'Files' })).toBeDisabled();
  });

  it('renders the exact workspace path through the technical value control', () => {
    mockState.snapshot = {
      chatState: 'idle',
      progressMessage: '',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Fix the project' }] },
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '📋 任务执行报告：Done\n\n✅ task-1: Done\n📂 修改已直接写入当前项目：D:\\projects\\very-long-workspace',
            },
          ],
        },
      ],
      session: { working_dir: 'D:\\projects\\very-long-workspace' },
    };

    render(
      <CodeProTaskPanel expanded onExpandedChange={vi.fn()} onWidthChange={vi.fn()} width={340} />
    );

    fireEvent.click(screen.getByText('Current project · Changes written'));

    expect(screen.getByRole('button', { name: 'Copy Project path' })).toBeVisible();
    expect(screen.getByText('D:\\projects\\very-long-workspace')).toHaveClass(
      'whitespace-pre-wrap',
      'break-all'
    );
  });

  it('clears an expanded task when the active session changes', async () => {
    mockState.sessionId = 'session-1';
    mockState.snapshot = {
      chatState: 'thinking',
      messages: [],
      progressMessage: '🔄 task-1: 修改代码',
      session: { working_dir: 'D:\\project' },
    };
    const view = render(
      <CodeProTaskPanel expanded onExpandedChange={vi.fn()} onWidthChange={vi.fn()} width={340} />
    );

    fireEvent.click(screen.getByRole('button', { name: /修改代码/ }));
    expect(screen.getByText('What this step does')).toBeInTheDocument();

    mockState.sessionId = 'session-2';
    mockState.snapshot = {
      chatState: 'thinking',
      messages: [],
      progressMessage: '🔄 task-2: 运行测试',
      session: { working_dir: 'D:\\project' },
    };
    view.rerender(
      <CodeProTaskPanel expanded onExpandedChange={vi.fn()} onWidthChange={vi.fn()} width={340} />
    );

    await waitFor(() => expect(screen.queryByText('What this step does')).toBeNull());
  });

  it('shows live progress and files without internal task ids or agent roles', () => {
    mockState.sessionId = 'session-live';
    mockState.snapshot = {
      chatState: 'thinking',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '修改项目' }] },
        {
          role: 'assistant',
          content: [
            {
              type: 'systemNotification',
              notificationType: 'codeProActivity',
              msg: 'CodePro · 已读取文件',
              data: {
                schema_version: 1,
                event_id: 'read-live',
                event_type: 'file_read',
                session_id: 'session-live',
                run_id: 'run-live',
                task_id: 'task-1',
                parent_task_id: null,
                agent_role: 'coder',
                effective_model: 'provider/model',
                status: 'completed',
                started_at: '2026-08-02T08:00:00.000Z',
                finished_at: '2026-08-02T08:00:01.000Z',
                title: '已读取文件',
                technical_details: null,
                path: 'D:\\project\\README.md',
                command_summary: null,
                exit_code: null,
                diff_summary: null,
                include_in_model_context: false,
                retryable: false,
                retry_from_event_id: null,
              },
            },
          ],
        },
      ],
      progressMessage:
        '🔄 task-1: 修改代码\n当前任务：task-1 · (Coder Agent)\n说明：更新实现\n验收目标：测试通过',
      session: { working_dir: 'D:\\project' },
    };

    render(
      <CodeProTaskPanel expanded onExpandedChange={vi.fn()} onWidthChange={vi.fn()} width={340} />
    );

    expect(screen.getByText('0/1 · Running')).toBeInTheDocument();
    expect(screen.getAllByText('修改代码').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Coder Agent/)).not.toBeInTheDocument();
    expect(screen.queryByText('task-1')).not.toBeInTheDocument();
    const filesTab = screen.getByRole('button', { name: 'Files (1)' });
    expect(filesTab).toBeEnabled();
    fireEvent.click(filesTab);
    expect(screen.getByText('README.md')).toHaveAttribute('title', 'D:\\project\\README.md');
  });

  it('renders an unrun validation in plain language even if the transport still says streaming', () => {
    mockState.sessionId = 'session-terminal-skipped';
    mockState.snapshot = {
      chatState: 'streaming',
      messages: [
        { id: 'user-1', role: 'user', content: [{ type: 'text', text: 'Analyze project' }] },
        {
          id: 'terminal-1',
          role: 'assistant',
          content: [
            {
              type: 'systemNotification',
              notificationType: 'turnTerminal',
              msg: 'CodePro terminal report',
              data: {
                schema_version: 1,
                session_id: 'session-terminal-skipped',
                run_id: 'run-1',
                terminal_message_id: 'terminal-1',
                source_user_message_id: 'user-1',
                status: 'completed',
                checkpoint_id: null,
                retry_strategy: 'not_available',
                visible_text_available: true,
                tool_action_count: 1,
                copy_artifact_ref: null,
                finished_at: '2026-08-27T08:00:01Z',
                report: {
                  outcome: 'skipped',
                  classification_counts: {
                    confirmed_bug: 0,
                    test_failure: 0,
                    environment_problem: 0,
                    codepro_incomplete: 0,
                    unverified: 0,
                  },
                  changed_files: [],
                  verification_summary: [
                    {
                      task_id: 'host-fallback-verify',
                      verdict: 'skipped',
                      command: null,
                      exit_code: null,
                      evidence_ref: 'verify-1',
                    },
                  ],
                  limitations: [],
                  recovery_action: 'none',
                },
              },
            },
          ],
        },
      ],
      progressMessage: '🔄 host-fallback-verify: Run project tests',
      session: { working_dir: 'D:\\project' },
    };

    render(
      <CodeProTaskPanel expanded onExpandedChange={vi.fn()} onWidthChange={vi.fn()} width={340} />
    );

    expect(screen.queryByText('0/1 · Running')).toBeNull();
    expect(screen.getByText('0/1 · Completed')).toBeVisible();
    expect(screen.getByText('Not dynamically tested')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Run project tests/ }));
    expect(screen.getByText('结果：动态验证没有运行')).toBeVisible();
    expect(screen.queryByText(/NOT_RUN/)).not.toBeInTheDocument();
  });

  it('does not claim progress is saved while a paused task has no committed checkpoint', () => {
    mockState.sessionId = 'session-paused';
    mockState.snapshot = {
      chatState: 'thinking',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Run tests' }] }],
      progressMessage: '⏸️ task-1: Run tests',
      session: { working_dir: 'D:\\project' },
    };

    render(
      <CodeProTaskPanel expanded onExpandedChange={vi.fn()} onWidthChange={vi.fn()} width={340} />
    );

    expect(
      screen.getByText('Task paused. CodePro is determining whether it can continue.')
    ).toBeVisible();
    expect(
      screen.queryByText('Progress is saved. Use Retry below the chat message to continue')
    ).toBeNull();
  });

  it('claims progress is saved only for a committed checkpoint terminal', () => {
    mockState.sessionId = 'session-checkpoint';
    mockState.snapshot = {
      chatState: 'thinking',
      messages: [
        { id: 'user-1', role: 'user', content: [{ type: 'text', text: 'Run tests' }] },
        {
          id: 'terminal-1',
          role: 'assistant',
          content: [
            {
              type: 'systemNotification',
              notificationType: 'turnTerminal',
              msg: 'Paused',
              data: {
                schema_version: 1,
                session_id: 'session-checkpoint',
                run_id: 'run-1',
                terminal_message_id: 'terminal-1',
                source_user_message_id: 'user-1',
                status: 'interrupted',
                checkpoint_id: 'checkpoint-1',
                retry_strategy: 'continue_checkpoint',
                visible_text_available: true,
                tool_action_count: 1,
                copy_artifact_ref: null,
                finished_at: '2026-08-25T00:00:00Z',
              },
            },
          ],
        },
      ],
      progressMessage: '⏸️ task-1: Run tests',
      session: { working_dir: 'D:\\project' },
    };

    render(
      <CodeProTaskPanel expanded onExpandedChange={vi.fn()} onWidthChange={vi.fn()} width={340} />
    );

    expect(
      screen.getByText('Progress is saved. Use Retry below the chat message to continue')
    ).toBeVisible();
  });

  it('shows Retry in the panel and requests replay_user_request for an interrupted terminal', () => {
    const onTerminalRetry = vi.fn();
    mockState.sessionId = 'session-replay';
    mockState.snapshot = {
      chatState: 'idle',
      messages: [
        { id: 'user-1', role: 'user', content: [{ type: 'text', text: 'Analyze project' }] },
        {
          id: 'terminal-replay',
          role: 'assistant',
          content: [
            {
              type: 'systemNotification',
              notificationType: 'turnTerminal',
              msg: 'Interrupted',
              data: {
                schema_version: 1,
                session_id: 'session-replay',
                run_id: 'run-replay',
                terminal_message_id: 'terminal-replay',
                source_user_message_id: 'user-1',
                status: 'interrupted',
                checkpoint_id: null,
                retry_strategy: 'replay_user_request',
                visible_text_available: false,
                tool_action_count: 1,
                copy_artifact_ref: null,
                finished_at: '2026-08-28T00:00:00Z',
              },
            },
          ],
        },
      ],
      progressMessage: '⏸️ task-1: Analyze project',
      session: { working_dir: 'D:\\project' },
    };

    render(
      <CodeProTaskPanel
        expanded
        onExpandedChange={vi.fn()}
        onWidthChange={vi.fn()}
        onTerminalRetry={onTerminalRetry}
        width={340}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onTerminalRetry).toHaveBeenCalledWith({
      sessionId: 'session-replay',
      terminalMessageId: 'terminal-replay',
      strategy: 'replay_user_request',
    });
  });

  it('does not show a panel Retry for AskUser plus not_available', () => {
    mockState.sessionId = 'session-ask-user';
    mockState.snapshot = {
      chatState: 'idle',
      messages: [
        { id: 'user-1', role: 'user', content: [{ type: 'text', text: 'Analyze project' }] },
        {
          id: 'terminal-ask-user',
          role: 'assistant',
          content: [
            {
              type: 'systemNotification',
              notificationType: 'turnTerminal',
              msg: 'Waiting for user',
              data: {
                schema_version: 1,
                session_id: 'session-ask-user',
                run_id: 'run-ask-user',
                terminal_message_id: 'terminal-ask-user',
                source_user_message_id: 'user-1',
                status: 'interrupted',
                checkpoint_id: null,
                retry_strategy: 'not_available',
                visible_text_available: true,
                tool_action_count: 1,
                copy_artifact_ref: null,
                finished_at: '2026-08-28T00:00:00Z',
                report: {
                  outcome: 'waiting_for_user',
                  classification_counts: {
                    confirmed_bug: 0,
                    test_failure: 0,
                    environment_problem: 0,
                    codepro_incomplete: 1,
                    unverified: 0,
                  },
                  changed_files: [],
                  verification_summary: [],
                  limitations: ['User input required'],
                  recovery_action: 'ask_user',
                },
              },
            },
          ],
        },
      ],
      progressMessage: '⏸️ task-1: Analyze project',
      session: { working_dir: 'D:\\project' },
    };

    render(
      <CodeProTaskPanel
        expanded
        onExpandedChange={vi.fn()}
        onWidthChange={vi.fn()}
        onTerminalRetry={vi.fn()}
        width={340}
      />
    );

    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('keeps the panel checkpoint button wired to continue_checkpoint', () => {
    const onTerminalRetry = vi.fn();
    mockState.sessionId = 'session-checkpoint-action';
    mockState.snapshot = {
      chatState: 'idle',
      messages: [
        { id: 'user-1', role: 'user', content: [{ type: 'text', text: 'Run tests' }] },
        {
          id: 'terminal-checkpoint-action',
          role: 'assistant',
          content: [
            {
              type: 'systemNotification',
              notificationType: 'turnTerminal',
              msg: 'Paused',
              data: {
                schema_version: 1,
                session_id: 'session-checkpoint-action',
                run_id: 'run-checkpoint',
                terminal_message_id: 'terminal-checkpoint-action',
                source_user_message_id: 'user-1',
                status: 'interrupted',
                checkpoint_id: 'checkpoint-1',
                retry_strategy: 'continue_checkpoint',
                visible_text_available: true,
                tool_action_count: 1,
                copy_artifact_ref: null,
                finished_at: '2026-08-28T00:00:00Z',
              },
            },
          ],
        },
      ],
      progressMessage: '⏸️ task-1: Run tests',
      session: { working_dir: 'D:\\project' },
    };

    render(
      <CodeProTaskPanel
        expanded
        onExpandedChange={vi.fn()}
        onWidthChange={vi.fn()}
        onTerminalRetry={onTerminalRetry}
        width={340}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onTerminalRetry).toHaveBeenCalledWith({
      sessionId: 'session-checkpoint-action',
      terminalMessageId: 'terminal-checkpoint-action',
      strategy: 'continue_checkpoint',
    });
  });

  it('labels a non-resumable pause as manual review', () => {
    mockState.sessionId = 'session-review';
    mockState.snapshot = {
      chatState: 'thinking',
      messages: [
        { id: 'user-1', role: 'user', content: [{ type: 'text', text: 'Run tests' }] },
        {
          id: 'terminal-review',
          role: 'assistant',
          content: [
            {
              type: 'systemNotification',
              notificationType: 'turnTerminal',
              msg: 'Review required',
              data: {
                schema_version: 1,
                session_id: 'session-review',
                run_id: 'run-review',
                terminal_message_id: 'terminal-review',
                source_user_message_id: 'user-1',
                status: 'interrupted',
                checkpoint_id: null,
                retry_strategy: 'not_available',
                visible_text_available: true,
                tool_action_count: 1,
                copy_artifact_ref: null,
                finished_at: '2026-08-25T00:00:00Z',
              },
            },
          ],
        },
      ],
      progressMessage: '⏸️ task-1: Run tests',
      session: { working_dir: 'D:\\project' },
    };

    render(
      <CodeProTaskPanel expanded onExpandedChange={vi.fn()} onWidthChange={vi.fn()} width={340} />
    );

    expect(
      screen.getByText('Task paused for review. Automatic retry is not available.')
    ).toBeVisible();
  });

  it('does not expose a resize separator in overlay layouts', () => {
    render(
      <CodeProTaskPanel
        expanded
        layout="overlay"
        onExpandedChange={vi.fn()}
        onWidthChange={vi.fn()}
        width={340}
      />
    );

    expect(screen.queryByRole('separator', { name: 'Resize task panel' })).toBeNull();
  });
});
