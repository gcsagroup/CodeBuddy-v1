import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChatSessionsContainer from './ChatSessionsContainer';
import { subscribeToAcpRecovery } from '../acp/acpConnection';
import { acpChatSessionController } from '../acp/chatSessionController';
import { acpChatSessionActions } from '../acp/chatSessionStore';
import { ChatState } from '../types/chatState';

vi.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams('resumeSessionId=session-1')],
}));

vi.mock('./BaseChat', () => ({
  default: ({ sessionId, isActiveSession }: { sessionId: string; isActiveSession: boolean }) =>
    <div data-active={isActiveSession}>{sessionId}</div>,
}));

vi.mock('../acp/acpConnection', () => ({
  subscribeToAcpRecovery: vi.fn(),
}));

vi.mock('../acp/chatSessionController', () => ({
  acpChatSessionController: {
    restoreSession: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('ChatSessionsContainer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acpChatSessionActions.setMessages('session-1', []);
    acpChatSessionActions.setChatState('session-1', ChatState.Idle);
  });
  afterEach(() => vi.restoreAllMocks());

  it('keeps background chats mounted while marking only the visible chat active', () => {
    const props = { setChat: vi.fn(), activeSessions: [{ sessionId: 'session-1' }, { sessionId: 'session-2' }] };
    const view = render(<ChatSessionsContainer {...props} isChatVisible />);
    expect(view.getByText('session-1')).toHaveAttribute('data-active', 'true');
    expect(view.getByText('session-2')).toHaveAttribute('data-active', 'false');
    view.rerender(<ChatSessionsContainer {...props} isChatVisible={false} />);
    expect(view.getByText('session-1')).toHaveAttribute('data-active', 'false');
    expect(view.getByText('session-2')).toHaveAttribute('data-active', 'false');
  });

  it('restores active chat sessions after ACP reconnects', () => {
    let onRecoveryChanged: ((recovering: boolean) => void) | undefined;
    vi.mocked(subscribeToAcpRecovery).mockImplementation((listener) => {
      onRecoveryChanged = listener;
      return () => undefined;
    });

    render(
      <ChatSessionsContainer
        setChat={vi.fn()}
        isChatVisible
        activeSessions={[{ sessionId: 'session-1' }, { sessionId: 'session-2' }]}
      />
    );

    onRecoveryChanged?.(false);

    expect(acpChatSessionController.restoreSession).toHaveBeenCalledTimes(2);
    expect(acpChatSessionController.restoreSession).toHaveBeenCalledWith('session-1');
    expect(acpChatSessionController.restoreSession).toHaveBeenCalledWith('session-2');
  });

  it('acknowledges a terminal only while its chat is visible and focused', () => {
    const send = vi.fn();
    Object.assign(window.electron, { desktopPet: vi.fn(), petSignal: send });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    acpChatSessionActions.setMessages('session-1', [
      {
        id: 'terminal-1',
        role: 'assistant',
        created: 1,
        metadata: { userVisible: true, agentVisible: false },
        content: [
          {
            type: 'systemNotification',
            notificationType: 'turnTerminal',
            msg: 'done',
            data: {
              schema_version: 1,
              session_id: 'session-1',
              run_id: 'run-1',
              terminal_message_id: 'terminal-1',
              source_user_message_id: 'user-1',
              status: 'completed',
              checkpoint_id: null,
              retry_strategy: 'not_available',
              visible_text_available: true,
              tool_action_count: 0,
              copy_artifact_ref: null,
              finished_at: '2026-10-19T10:00:00Z',
            },
          },
        ],
      },
    ]);
    send.mockClear();
    const props = { setChat: vi.fn(), activeSessions: [{ sessionId: 'session-1' }] };
    const view = render(<ChatSessionsContainer {...props} isChatVisible={false} />);
    act(() => window.dispatchEvent(new Event('focus')));
    expect(send).not.toHaveBeenCalledWith('pet-read', expect.anything());

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    view.rerender(<ChatSessionsContainer {...props} isChatVisible />);
    act(() => window.dispatchEvent(new Event('focus')));
    expect(send).not.toHaveBeenCalledWith('pet-read', expect.anything());

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(send).not.toHaveBeenCalledWith('pet-read', expect.anything());

    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(send).toHaveBeenCalledWith('pet-read', {
      sessionId: 'session-1',
      terminalId: 'terminal-1',
    });
  });
});
