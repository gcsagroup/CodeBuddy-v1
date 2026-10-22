import { act, render, type RenderOptions, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAcpPermissionRequest } from '../acp/permissionRequests';
import { IntlTestWrapper } from '../i18n/test-utils';
import ToolApprovalButtons from './ToolApprovalButtons';
import { ToolCallExpandable } from './ToolCallExpandable';

const permissionRegistry = vi.hoisted(() => ({
  pending: true,
  listeners: new Set<() => void>(),
  resolve: vi.fn(),
}));

vi.mock('../acp/permissionRequests', () => ({
  resolveAcpPermissionRequest: permissionRegistry.resolve,
  isAcpPermissionRequestPending: (sessionId: string, id: string) =>
    permissionRegistry.pending &&
    !permissionRegistry.resolve.mock.calls.some(
      (args, index) =>
        args[0] === sessionId &&
        args[1] === id &&
        permissionRegistry.resolve.mock.results[index]?.value === true
    ),
  subscribeAcpPermissionRequests: (listener: () => void) => {
    permissionRegistry.listeners.add(listener);
    return () => permissionRegistry.listeners.delete(listener);
  },
}));

const renderWithIntl = (ui: React.ReactElement, options?: RenderOptions) =>
  render(ui, { wrapper: IntlTestWrapper, ...options });

const resolveAcpPermissionRequestMock = vi.mocked(resolveAcpPermissionRequest);

describe('ToolApprovalButtons', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionRegistry.pending = true;
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
    expect(screen.getByText('Read file - Allowed once')).toBeVisible();
    rerender(view(false));
    expect(screen.getByRole('button', { name: 'Completed operations' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(screen.queryByText('Read file - Allowed once')).not.toBeInTheDocument();
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
    const history = screen.getByRole('button', {
      name: 'Completed operations',
    });
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
    expect(screen.getByText('Run command - Allowed once')).toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: 'Allow Once' })).not.toBeInTheDocument();
  });

  it('removes mounted approval buttons as soon as the transport request expires', () => {
    renderWithIntl(
      <ToolApprovalButtons
        data={{
          id: 'expires-live',
          toolName: 'send_message',
          sessionId: 'child-session',
        }}
      />
    );
    expect(screen.getByRole('button', { name: 'Allow Once' })).toBeInTheDocument();
    act(() => {
      permissionRegistry.pending = false;
      for (const listener of permissionRegistry.listeners) listener();
    });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('This approval request is no longer active.')).toBeInTheDocument();
    expect(screen.queryByText(/Allowed once/)).not.toBeInTheDocument();
    expect(resolveAcpPermissionRequestMock).not.toHaveBeenCalled();
  });

  it('renders a replayed inactive card without inventing an approval decision', () => {
    permissionRegistry.pending = false;
    renderWithIntl(
      <ToolApprovalButtons
        data={{
          id: 'replayed-old',
          toolName: 'send_message',
          sessionId: 'history-session',
          isClicked: true,
        }}
      />
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('This approval request is no longer active.')).toBeInTheDocument();
    expect(screen.queryByText(/Allowed|Denied/)).not.toBeInTheDocument();
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
    expect(screen.getByText('Run command - Allowed once')).toBeInTheDocument();

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
    expect(screen.queryByText('Run command - Allowed once')).not.toBeInTheDocument();
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
          permissionClass: 'legacy',
          authorizationScope: 'session',
          availableActions: ['always_allow', 'always_deny'],
        }}
      />
    );

    expect(
      screen.getByRole('button', { name: 'Allow this tool for this session' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Allow this tool for this session' })
    ).toHaveAttribute(
      'title',
      'Only this tool in this conversation. Restarting the app or reconnecting the tool clears this choice.'
    );
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
    expect(resolveAcpPermissionRequestMock).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Allow for this task' }));

    expect(screen.getByText('Computer Focus - Allowed for this task')).toBeInTheDocument();
    expect(screen.queryByText('Computer Focus - Always allowed')).not.toBeInTheDocument();
  });

  it('does not grant permission when the scope menu is opened or dismissed', async () => {
    renderWithIntl(
      <ToolApprovalButtons
        data={{
          id: 'scope-menu-dismiss',
          toolName: 'fixture_tool',
          sessionId: 'scope-menu-session',
          authorizationScope: 'session',
          availableActions: ['allow_once', 'always_allow', 'deny_once'],
        }}
      />
    );

    const trigger = screen.getByRole('button', { name: 'Allow this tool for this session' });
    await userEvent.click(trigger);
    expect(
      screen.getByRole('menuitem', { name: 'Allow this tool for this session' })
    ).toBeVisible();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(resolveAcpPermissionRequestMock).not.toHaveBeenCalled();

    resolveAcpPermissionRequestMock.mockReturnValueOnce(true);
    await userEvent.click(screen.getByRole('button', { name: 'Allow Once' }));
    expect(resolveAcpPermissionRequestMock).toHaveBeenCalledExactlyOnceWith(
      'scope-menu-session',
      'scope-menu-dismiss',
      'allow_once'
    );
  });

  it('removes an open scope menu when its permission request expires', async () => {
    renderWithIntl(
      <ToolApprovalButtons
        data={{
          id: 'scope-menu-expiry',
          toolName: 'fixture_tool',
          sessionId: 'scope-expiry-session',
          authorizationScope: 'session',
          availableActions: ['allow_once', 'always_allow', 'deny_once'],
        }}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Allow this tool for this session' }));
    act(() => {
      permissionRegistry.pending = false;
      permissionRegistry.listeners.forEach((listener) => listener());
    });
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow Once' })).not.toBeInTheDocument();
    expect(screen.getByText('This approval request is no longer active.')).toBeVisible();
    expect(resolveAcpPermissionRequestMock).not.toHaveBeenCalled();
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
