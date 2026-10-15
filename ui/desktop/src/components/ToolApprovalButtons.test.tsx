import { render, type RenderOptions, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAcpPermissionRequest } from '../acp/permissionRequests';
import { IntlTestWrapper } from '../i18n/test-utils';
import ToolApprovalButtons from './ToolApprovalButtons';
import { ToolCallExpandable } from './ToolCallExpandable';

vi.mock('../acp/permissionRequests', () => ({
  resolveAcpPermissionRequest: vi.fn(),
}));

const renderWithIntl = (ui: React.ReactElement, options?: RenderOptions) =>
  render(ui, { wrapper: IntlTestWrapper, ...options });

const resolveAcpPermissionRequestMock = vi.mocked(resolveAcpPermissionRequest);

describe('ToolApprovalButtons', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('collapses completed history after a real approval click without treating it as reading', async () => {
    resolveAcpPermissionRequestMock.mockReturnValueOnce(true);
    const view = (live: boolean) => (
      <ToolCallExpandable label="Completed operations" collapsible={!live}>
        <ToolApprovalButtons
          data={{
            id: 'approval-should-not-pin-history',
            toolName: 'read',
            sessionId: 'approval-collapse-session',
          }}
        />
      </ToolCallExpandable>
    );
    const { rerender } = renderWithIntl(view(true));
    await userEvent.click(screen.getByRole('button', { name: 'Allow Once' }));
    expect(resolveAcpPermissionRequestMock).toHaveBeenCalledWith(
      'approval-collapse-session',
      'approval-should-not-pin-history',
      'allow_once'
    );
    expect(screen.getByText('read - Allowed once')).toBeVisible();
    rerender(view(false));
    expect(screen.getByRole('button', { name: 'Completed operations' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(screen.queryByText('read - Allowed once')).not.toBeInTheDocument();
  });

  it('retains live details intentionally opened outside the approval actions', async () => {
    const view = (live: boolean) => (
      <ToolCallExpandable label="Completed operations" collapsible={!live}>
        <button type="button">Inspect tool details</button>
      </ToolCallExpandable>
    );
    const { rerender } = renderWithIntl(view(true));
    await userEvent.click(screen.getByRole('button', { name: 'Inspect tool details' }));
    rerender(view(false));
    const history = screen.getByRole('button', { name: 'Completed operations' });
    expect(history).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Inspect tool details' })).toBeVisible();
    await userEvent.click(history);
    expect(history).toHaveAttribute('aria-expanded', 'false');
  });

  it('marks the approval accepted when the ACP request resolves', async () => {
    resolveAcpPermissionRequestMock.mockReturnValueOnce(true);

    renderWithIntl(
      <ToolApprovalButtons
        data={{
          id: 'tool-call-approved',
          toolName: 'developer__shell',
          sessionId: 'session-1',
        }}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Allow Once' }));

    expect(resolveAcpPermissionRequestMock).toHaveBeenCalledWith(
      'session-1',
      'tool-call-approved',
      'allow_once'
    );
    expect(screen.getByText('developer__shell - Allowed once')).toBeInTheDocument();
  });

  it('shows a stale request error when ACP has no pending request', async () => {
    resolveAcpPermissionRequestMock.mockReturnValueOnce(false);

    renderWithIntl(
      <ToolApprovalButtons
        data={{
          id: 'tool-call-rerun',
          toolName: 'developer__shell',
          sessionId: 'session-1',
        }}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Allow Once' }));

    expect(resolveAcpPermissionRequestMock).toHaveBeenCalledWith(
      'session-1',
      'tool-call-rerun',
      'allow_once'
    );
    expect(screen.getByText('This approval request is no longer active.')).toBeInTheDocument();
    expect(screen.queryByText('developer__shell - Allowed once')).not.toBeInTheDocument();
  });

  it('does not reuse an approval decision for the same tool call id in another session', async () => {
    resolveAcpPermissionRequestMock.mockReturnValueOnce(true);

    const { rerender } = renderWithIntl(
      <ToolApprovalButtons
        data={{
          id: 'tool-call-shared',
          toolName: 'developer__shell',
          sessionId: 'session-1',
        }}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Allow Once' }));
    expect(screen.getByText('developer__shell - Allowed once')).toBeInTheDocument();

    rerender(
      <ToolApprovalButtons
        data={{
          id: 'tool-call-shared',
          toolName: 'developer__shell',
          sessionId: 'session-2',
        }}
      />
    );

    expect(screen.getByRole('button', { name: 'Allow Once' })).toBeInTheDocument();
    expect(screen.queryByText('developer__shell - Allowed once')).not.toBeInTheDocument();
  });

  it('renders only ACP actions with scope-specific labels', () => {
    const { rerender } = renderWithIntl(
      <ToolApprovalButtons
        data={{
          id: 'tool-call-task-scope',
          toolName: 'developer__shell',
          sessionId: 'session-actions',
          permissionClass: 'high_risk',
          authorizationScope: 'task',
          availableActions: ['allow_once', 'always_allow', 'deny_once', 'always_deny'],
        }}
      />
    );

    expect(screen.getByRole('button', { name: 'Allow Once' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow for this task' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deny Once' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deny for this task' })).toBeInTheDocument();
    expect(screen.getByTestId('tool-approval-actions')).toHaveClass('flex-wrap');

    rerender(
      <ToolApprovalButtons
        data={{
          id: 'tool-call-session-scope',
          toolName: 'developer__shell',
          sessionId: 'session-actions',
          permissionClass: 'workspace_write',
          authorizationScope: 'session',
          availableActions: ['always_allow', 'always_deny'],
        }}
      />
    );

    expect(screen.getByRole('button', { name: 'Allow for this session' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deny for this session' })).toBeInTheDocument();
  });

  it('keeps the task authorization scope visible after approval', async () => {
    resolveAcpPermissionRequestMock.mockReturnValueOnce(true);
    renderWithIntl(
      <ToolApprovalButtons
        data={{
          id: 'tool-call-task-approved',
          toolName: 'computer_focus',
          sessionId: 'session-task-approved',
          permissionClass: 'high_risk',
          authorizationScope: 'task',
          availableActions: ['allow_once', 'always_allow'],
        }}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Allow for this task' }));

    expect(screen.getByText('computer_focus - Allowed for this task')).toBeInTheDocument();
    expect(screen.queryByText('computer_focus - Always allowed')).not.toBeInTheDocument();
  });

  it('hides unsafe allow actions for forbidden and global high-risk tools', () => {
    const { rerender } = renderWithIntl(
      <ToolApprovalButtons
        data={{
          id: 'tool-call-forbidden',
          toolName: 'developer__shell',
          sessionId: 'session-safety',
          permissionClass: 'forbidden',
          authorizationScope: 'task',
          availableActions: ['allow_once', 'always_allow', 'deny_once'],
        }}
      />
    );

    expect(screen.queryByRole('button', { name: /Allow/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deny Once' })).toBeInTheDocument();

    rerender(
      <ToolApprovalButtons
        data={{
          id: 'tool-call-global-high-risk',
          toolName: 'developer__shell',
          sessionId: 'session-safety',
          permissionClass: 'high_risk',
          authorizationScope: 'global',
          availableActions: ['allow_once', 'always_allow', 'deny_once'],
        }}
      />
    );

    expect(screen.getByRole('button', { name: 'Allow Once' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Always Allow' })).not.toBeInTheDocument();

    rerender(
      <ToolApprovalButtons
        data={{
          id: 'tool-call-global-external-write',
          toolName: 'developer__shell',
          sessionId: 'session-safety',
          permissionClass: 'external_write',
          authorizationScope: 'global',
          availableActions: ['allow_once', 'always_allow', 'deny_once'],
        }}
      />
    );

    expect(screen.getByRole('button', { name: 'Allow Once' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Always Allow' })).not.toBeInTheDocument();

    rerender(
      <ToolApprovalButtons
        data={{
          id: 'tool-call-global-read-only',
          toolName: 'developer__shell',
          sessionId: 'session-safety',
          permissionClass: 'read_only',
          authorizationScope: 'global',
          availableActions: ['always_allow', 'always_deny'],
        }}
      />
    );

    expect(screen.getByRole('button', { name: 'Always Allow' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Always Deny' })).toBeInTheDocument();
  });
});
