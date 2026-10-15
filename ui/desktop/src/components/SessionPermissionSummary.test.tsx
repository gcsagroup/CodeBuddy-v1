import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import type { Session } from '../types/session';
import { SessionPermissionSummary } from './SessionPermissionSummary';

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
  it('keeps an unknown mode visible instead of substituting the default', () => {
    render(<SessionPermissionSummary session={session()} />, { wrapper: IntlTestWrapper });
    fireEvent.click(screen.getByText('Not synchronized'));
    expect(screen.getByText('Workspace permissions have not been synchronized.')).toBeVisible();
  });

  it.each([
    ['writable_project', 'Bound project: /project. Tool permission rules still apply.'],
    ['root_container', 'Root folder: /project. Select a project before writing files.'],
    [
      'project_container',
      'Project parent: /project. The parent is not authorized for project writes.',
    ],
    ['unbound', 'No project is authorized for writing.'],
  ])('describes the actual %s binding', (workspaceBinding, expected) => {
    render(
      <SessionPermissionSummary
        session={session({ goose_mode: 'smart_approve', extension_data: { workspaceBinding } })}
      />,
      { wrapper: IntlTestWrapper }
    );
    fireEvent.click(screen.getByText('Read-only auto-approval (Smart)'));
    expect(screen.getByText(expected)).toBeVisible();
  });

  it('makes autonomous full access explicit in the session summary', () => {
    render(<SessionPermissionSummary session={session({ goose_mode: 'auto' })} />, {
      wrapper: IntlTestWrapper,
    });
    fireEvent.click(screen.getByText('Full access (Autonomous)'));
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
        session={session({ goose_mode: 'approve', session_type: 'user' })}
      />,
      { wrapper: IntlTestWrapper }
    );
    fireEvent.click(screen.getByText('Ask for approval (Manual)'));
    expect(
      screen.getByText(
        'Working directory: /project. This does not grant permission for every action.'
      )
    ).toBeVisible();
    rerender(<SessionPermissionSummary session={session({ id: 'two', goose_mode: 'chat' })} />);
    expect(
      screen.getByRole('button', { name: 'How should actions be approved?' })
    ).toHaveTextContent('Chat only');
    expect(
      screen.getByRole('button', { name: 'How should actions be approved?' })
    ).not.toHaveTextContent('Manual');
  });
});

it('keeps the parent restriction visible even in autonomous mode', () => {
  render(
    <SessionPermissionSummary
      session={session({
        goose_mode: 'auto',
        extension_data: { workspaceBinding: 'project_container' },
      })}
    />,
    { wrapper: IntlTestWrapper }
  );
  fireEvent.click(screen.getByRole('button', { name: 'How should actions be approved?' }));
  expect(
    screen.getByText('Project parent: /project. The parent is not authorized for project writes.')
  ).toBeVisible();
});
