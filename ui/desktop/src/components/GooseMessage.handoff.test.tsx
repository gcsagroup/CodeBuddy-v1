import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import type { Message } from '../types/message';
import GooseMessage from './GooseMessage';

function terminal(status: 'interrupted' | 'cancelled', text = ''): Message {
  return {
    id: 'terminal',
    role: 'assistant',
    created: 1,
    metadata: { userVisible: true, agentVisible: false },
    content: [
      { type: 'text', text },
      {
        type: 'systemNotification',
        notificationType: 'turnTerminal',
        msg: 'CodePro turn finished',
        data: {
          schema_version: 1,
          session_id: 'session',
          run_id: 'run',
          terminal_message_id: 'terminal',
          source_user_message_id: 'user',
          status,
          checkpoint_id: null,
          retry_strategy: 'not_available',
          // Earlier progress text can set this even without a final explanation.
          visible_text_available: true,
          tool_action_count: 1,
          copy_artifact_ref: null,
          finished_at: '2026-10-07T10:00:00Z',
        },
      },
    ],
  };
}

function show(message: Message) {
  return render(
    <GooseMessage
      sessionId="session"
      message={message}
      messages={[message]}
      toolCallNotifications={new Map()}
      append={vi.fn()}
      isStreaming={false}
    />,
    { wrapper: IntlTestWrapper }
  );
}

describe('handoff versus an unexplained interruption', () => {
  it('renders the terminal handoff once, without a second host explanation', () => {
    const summary = '缺少真实订单文件，因此没有完成实跑核对。补齐文件后可以继续。';
    show(terminal('interrupted', summary));
    expect(screen.getAllByText(summary)).toHaveLength(1);
    expect(screen.queryByText(/This task was interrupted/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Stopped at your request/)).not.toBeInTheDocument();
  });

  it('still explains a real interruption even when earlier progress was visible', () => {
    show(terminal('interrupted'));
    expect(
      screen.getByText(/This task was interrupted and completion has not been confirmed/)
    ).toBeInTheDocument();
  });

  it('still tells the user when they stopped execution', () => {
    show(terminal('cancelled'));
    expect(screen.getByText(/Stopped at your request/)).toBeInTheDocument();
  });
});
