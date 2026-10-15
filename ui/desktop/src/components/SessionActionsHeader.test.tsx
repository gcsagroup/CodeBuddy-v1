import { fireEvent, render as testingRender, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { SessionActionsContextMenu } from './SessionActionsHeader';

describe('SessionActionsContextMenu', () => {
  it('opens chat actions from the sidebar row right-click only', async () => {
    testingRender(
      <SessionActionsContextMenu
        session={{ id: 'session-1', name: 'Ledger chat', sessionType: 'user' }}
      >
        <div>Ledger chat</div>
      </SessionActionsContextMenu>,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.queryByText('Rename session')).not.toBeInTheDocument();
    fireEvent.contextMenu(screen.getByText('Ledger chat'));
    expect(await screen.findByText('Rename session')).toBeVisible();
    expect(screen.getByText('Duplicate session')).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Duplicate session' })).not.toHaveAttribute(
      'data-disabled'
    );
    expect(screen.getByText('View session JSON')).toBeVisible();
  });

  it('disables CodePro copying and explains how to start independent work', async () => {
    testingRender(
      <SessionActionsContextMenu
        session={{ id: 'codepro-1', name: 'CodePro task', sessionType: 'code_pro' }}
      >
        <div>CodePro task</div>
      </SessionActionsContextMenu>,
      { wrapper: IntlTestWrapper }
    );
    fireEvent.contextMenu(screen.getByText('CodePro task'));
    const item = await screen.findByRole('menuitem', { name: 'Duplicate session' });
    expect(item).toHaveAttribute('data-disabled');
    expect(item).toHaveAttribute('title', expect.stringContaining('Start a new task'));
  });
});
