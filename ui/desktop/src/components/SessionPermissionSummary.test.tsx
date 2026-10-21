import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { acpSetSessionMode } from '../acp/sessions';
import { IntlTestWrapper } from '../i18n/test-utils';
import type { Session } from '../types/session';
import { PermissionPicker, SessionPermissionSummary } from './SessionPermissionSummary';

vi.mock('../acp/sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../acp/sessions')>()),
  acpSetSessionMode: vi.fn(),
}));

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'one',
    name: 'Test',
    created_at: '',
    updated_at: '',
    message_count: 0,
    working_dir: '/project',
    session_type: 'code_pro',
    extension_data: {},
    ...overrides,
  };
}

describe('SessionPermissionSummary', () => {
  it('allows an explicit permission draft before any session or default has loaded', async () => {
    const select = vi.fn();
    vi.mocked(acpSetSessionMode).mockClear();
    render(<PermissionPicker draft onModeChange={select} inline />, { wrapper: IntlTestWrapper });
    fireEvent.click(screen.getByRole('button', { name: 'How should actions be approved?' }));
    const option = screen.getByRole('radio', { name: /Workspace write/ });
    expect(option).toBeEnabled();
    fireEvent.click(option);
    await waitFor(() => expect(select).toHaveBeenCalledWith('workspace-write'));
    expect(acpSetSessionMode).not.toHaveBeenCalled();
  });
  it('offers exactly three native presets while busy and explains child snapshots', async () => {
    vi.mocked(acpSetSessionMode).mockResolvedValue(undefined);
    render(
      <SessionPermissionSummary session={session({ goose_mode: 'danger-full-access' })} busy />,
      {
        wrapper: IntlTestWrapper,
      }
    );
    fireEvent.click(screen.getByRole('button', { name: 'How should actions be approved?' }));
    expect(
      screen.getByText(
        'Changes apply to this Agent. Running actions are unchanged; existing subagents keep their delegated permissions.'
      )
    ).toBeVisible();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    const mode = screen.getByRole('radio', { name: /Read only/ });
    expect(mode).toBeEnabled();
    fireEvent.click(mode);
    await waitFor(() => expect(acpSetSessionMode).toHaveBeenCalledWith('one', 'read-only'));
  });

  it('keeps an unknown mode visible instead of substituting the default', () => {
    render(<SessionPermissionSummary session={session()} />, { wrapper: IntlTestWrapper });
    fireEvent.click(screen.getByText('Not synchronized'));
    expect(screen.getByText('Workspace permissions have not been synchronized.')).toBeVisible();
  });

  it.each<[string, string | null]>([
    [
      'writable_project',
      'Working directory: /project. This does not grant permission for every action.',
    ],
    [
      'root_container',
      'Working directory: /project. This does not grant permission for every action.',
    ],
    [
      'project_container',
      'Working directory: /project. This does not grant permission for every action.',
    ],
    ['unbound', 'Working directory: /project. This does not grant permission for every action.'],
  ])('shows the relevant scope for %s', (workspaceBinding, expected) => {
    render(
      <SessionPermissionSummary
        session={session({ goose_mode: 'workspace-write', extension_data: { workspaceBinding } })}
      />,
      { wrapper: IntlTestWrapper }
    );
    fireEvent.click(screen.getByText('Workspace write'));
    if (expected === null) {
      expect(screen.queryByText(/^Bound project:/)).not.toBeInTheDocument();
    } else {
      expect(screen.getByText(expected)).toBeVisible();
    }
  });

  it('makes autonomous full access explicit in the session summary', () => {
    render(<SessionPermissionSummary session={session({ goose_mode: 'danger-full-access' })} />, {
      wrapper: IntlTestWrapper,
    });
    fireEvent.click(screen.getByText('Full access'));
    expect(screen.getByRole('radio', { name: /Full access/ })).toBeChecked();
    expect(
      screen.getByText(
        'Applies to this conversation only. Existing tool permission rules still apply.'
      )
    ).toBeVisible();
  });

  it('updates current mode on session changes without treating ordinary cwd as a grant', () => {
    const { rerender } = render(
      <SessionPermissionSummary
        session={session({ goose_mode: 'read-only', session_type: 'user' })}
      />,
      { wrapper: IntlTestWrapper }
    );
    fireEvent.click(screen.getByText('Read only'));
    expect(
      screen.getByText(
        'Working directory: /project. This does not grant permission for every action.'
      )
    ).toBeVisible();
    rerender(
      <SessionPermissionSummary session={session({ id: 'two', goose_mode: 'workspace-write' })} />
    );
    expect(
      screen.getByRole('button', { name: 'How should actions be approved?' })
    ).toHaveTextContent('Workspace write');
    expect(
      screen.getByRole('button', { name: 'How should actions be approved?' })
    ).not.toHaveTextContent('Manual');
  });
});

it('does not claim that full access still has a file sandbox', () => {
  render(
    <SessionPermissionSummary
      session={session({
        goose_mode: 'danger-full-access',
        extension_data: { workspaceBinding: 'project_container' },
      })}
    />,
    { wrapper: IntlTestWrapper }
  );
  fireEvent.click(screen.getByRole('button', { name: 'How should actions be approved?' }));
  expect(
    screen.getByText(
      'The file and command sandbox is disabled for this Agent. Explicit tool restrictions still apply.'
    )
  ).toBeVisible();
});
