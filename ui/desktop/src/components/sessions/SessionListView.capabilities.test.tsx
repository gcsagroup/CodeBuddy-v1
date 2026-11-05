import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { acpForkSession, acpListSessions } from '../../acp/sessions';
import SessionListView from './SessionListView';

vi.mock('../../acp/sessions', () => ({
  acpListSessions: vi.fn(),
  acpForkSession: vi.fn().mockResolvedValue('copy'),
}));

describe('history copy capability', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('branches both task and ordinary conversations', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    Object.assign(window.electron, { getConfig: () => ({ GOOSE_DISABLE_NOSTR_SHARING: true }) });
    const now = new Date().toISOString();
    vi.mocked(acpListSessions).mockResolvedValue({
      nextCursor: null,
      sessions: [
        { id: 'codepro', name: 'Project task', sessionType: 'code_pro' as const },
        { id: 'ordinary', name: 'Ordinary chat', sessionType: 'user' as const },
      ].map((session) => ({
        ...session,
        workingDir: '/tmp',
        createdAt: now,
        updatedAt: now,
        messageCount: 1,
      })),
    });
    render(<SessionListView onSelectSession={vi.fn()} workspaceMode="unified" />, {
      wrapper: IntlTestWrapper,
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'More actions for Project task' }));
    await user.click(await screen.findByTitle('Branch conversation'));
    expect(acpForkSession).toHaveBeenCalledWith('codepro');
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'More actions for Ordinary chat' }));
    await user.click(screen.getByTitle('Branch conversation'));
    expect(acpForkSession).toHaveBeenCalledWith('ordinary');
  });
});
