import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConversationBranchButton } from './ConversationBranchButton';
import { IntlTestWrapper } from '../i18n/test-utils';
import { acpForkSession } from '../acp/sessions';
import { AppEvents } from '../constants/events';
import type { Message } from '../types/message';

vi.mock('../acp/sessions', () => ({ acpForkSession: vi.fn().mockResolvedValue('branch-id') }));
const msg = (id: string, role: 'user' | 'assistant'): Message => ({ id, role, created: 10,
  metadata: { userVisible: true, agentVisible: true }, content: [{ type: 'text', text: id }] });

describe('reply branches', () => {
  it('uses the next user message id even when turns share the same timestamp, and opens the result', async () => {
    const messages = [msg('user-a', 'user'), msg('answer-a', 'assistant'), msg('user-b', 'user')];
    const opened = vi.fn();
    window.addEventListener(AppEvents.SESSION_FORKED, opened);
    try {
      render(<ConversationBranchButton sessionId="source" message={messages[1]} messages={messages} />, { wrapper: IntlTestWrapper });
      fireEvent.click(screen.getByRole('button', { name: 'Branch after this turn' }));
      await waitFor(() => expect(opened).toHaveBeenCalledOnce());
      expect(acpForkSession).toHaveBeenCalledWith('source', undefined, 'user-b');
      expect(opened.mock.calls[0][0].detail).toEqual({ newSessionId: 'branch-id' });
    } finally { window.removeEventListener(AppEvents.SESSION_FORKED, opened); }
  });
});
