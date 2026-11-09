import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import type { Message } from '../types/message';
import GooseMessage from './GooseMessage';
import { DeliveredMediaScope } from './GeneratedMedia';

function terminal(status: 'interrupted' | 'cancelled' | 'failed' | 'completed', text = ''): Message {
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

function show(message: Message, deliveredPaths: string[] = []) {
  return render(
    <DeliveredMediaScope paths={deliveredPaths}>
    <GooseMessage
      sessionId="session"
      message={message}
      messages={[message]}
      toolCallNotifications={new Map()}
      append={vi.fn()}
      isStreaming={false}
    />
    </DeliveredMediaScope>,
    { wrapper: IntlTestWrapper }
  );
}

describe('handoff versus an unexplained interruption', () => {
  it('shows the missing final reply only when the completed turn also lacks delivered media', () => {
    const message = terminal('completed');
    const record = message.content.find(c => c.type === 'systemNotification');
    if (record?.type === 'systemNotification')
      record.data = { ...(record.data as object), last_response_text_available: false };
    const empty = show(message);
    expect(screen.getByText(/model response ended without a final reply/i)).toBeVisible();
    empty.unmount();
    show(message, ['generated-images/real-job/1.png']);
    expect(screen.queryByText(/model response ended without a final reply/i)).not.toBeInTheDocument();
  });
  it('does not invent a test failure when a model request fails without verification', () => {
    const message = terminal('failed');
    const notification = message.content.find((content) => content.type === 'systemNotification');
    if (notification?.type === 'systemNotification')
      notification.data = {
        ...(notification.data as object),
        report: {
          outcome: 'failed',
          classification_counts: {
            confirmed_bug: 0,
            test_failure: 0,
            environment_problem: 1,
            codepro_incomplete: 0,
            unverified: 0,
          },
          changed_files: [],
          verification_summary: [],
          limitations: ['EPERM: operation not permitted, rename state.json.tmp -> state.json'],
          recovery_action: 'manual_review',
        },
      };
    show(message);
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByText('Not completed')).toBeInTheDocument();
    expect(screen.queryByText('Tests failed')).not.toBeInTheDocument();
    const details = screen.getByText('Why this task did not finish').closest('details');
    expect(details).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('Why this task did not finish'));
    expect(details).toHaveAttribute('open');
    expect(screen.getByText(/EPERM: operation not permitted/)).toBeVisible();
    expect(screen.queryByText(/Stopped at your request/)).not.toBeInTheDocument();
  });
  it('renders the terminal handoff once, without a second host explanation', () => {
    const summary = '缺少真实订单文件，因此没有完成实跑核对。补齐文件后可以继续。';
    show(terminal('interrupted', summary));
    expect(screen.getAllByText(summary)).toHaveLength(1);
    expect(screen.queryByText(/This task was interrupted/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Stopped at your request/)).not.toBeInTheDocument();
  });

  it('shows a short stopped status instead of an unverified completion judgment', () => {
    show(terminal('interrupted'));
    expect(screen.getByText('Stopped')).toBeInTheDocument();
    expect(screen.queryByText(/completion has not been confirmed/)).not.toBeInTheDocument();
  });

  it('still tells the user when they stopped execution', () => {
    const message = terminal('cancelled');
    const notification = message.content.find((content) => content.type === 'systemNotification');
    if (notification?.type === 'systemNotification')
      notification.data = { ...(notification.data as object), last_response_text_available: false };
    show(message);
    expect(screen.getByText(/Stopped at your request/)).toBeInTheDocument();
    expect(
      screen.queryByText(/The model response ended without a final reply/)
    ).not.toBeInTheDocument();
  });
});

describe('native response length recovery', () => {
  function limited(extra: object = {}, text = '') {
    const message = terminal('interrupted', text);
    const notification = message.content.find((content) => content.type === 'systemNotification');
    if (notification?.type === 'systemNotification')
      notification.data = {
        ...(notification.data as object),
        stop_reason: 'max_tokens',
        output_limit: {
          automaticAttempts: 1,
          maxAutomaticAttempts: 1,
          budget: {
            requestedTokens: 32768,
            effectiveTokens: 32768,
            capacityTokens: 32768,
            contextLimit: 262144,
            source: 'fallback',
          },
        },
        ...extra,
      };
    return message;
  }
  const input: Message = {
    id: 'user',
    role: 'user',
    created: 0,
    metadata: { userVisible: true, agentVisible: true },
    content: [{ type: 'text', text: 'Original user task' }],
  };
  function display(message: Message, after: Message[] = [], running = false) {
    const append = vi.fn();
    render(
      <GooseMessage
        sessionId="session"
        message={message}
        messages={[input, ...after, message]}
        toolCallNotifications={new Map()}
        append={append}
        isStreaming={false}
        isTurnRunning={running}
      />,
      { wrapper: IntlTestWrapper }
    );
    return append;
  }
  it('explains the exhausted recovery, exposes budget provenance, and only continues on an explicit click', () => {
    const append = display(limited());
    expect(screen.getByText(/length limit again after one recovery attempt/)).toBeInTheDocument();
    expect(screen.getByText(/service output capacity has not been confirmed/)).toBeInTheDocument();
    expect(screen.queryByText(/Stopped at your request/)).not.toBeInTheDocument();
    expect(append).not.toHaveBeenCalled();
    const button = screen.getByRole('button', { name: 'Try continuing' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith(expect.stringContaining('preserve completed work'));
  });
  it('retains existing error text and the length explanation together', () => {
    display(limited({}, 'Recorded diagnostic'));
    expect(screen.getByText('Recorded diagnostic')).toBeInTheDocument();
    expect(screen.getByText(/length limit again/)).toBeInTheDocument();
  });
  it('shows two recovery attempts without claiming the task completed', () => {
    const legacy = limited();
    const data = legacy.content.find((content) => content.type === 'systemNotification');
    const budget =
      data?.type === 'systemNotification'
        ? (data.data as { output_limit: { budget: object } }).output_limit.budget
        : undefined;
    const append = display(
      limited({ output_limit: { automaticAttempts: 2, maxAutomaticAttempts: 2, budget } })
    );
    expect(screen.getByText(/length limit again after 2 recovery attempts/)).toBeInTheDocument();
    expect(screen.getByText(/Automatic recovery attempts: 2\/2/)).toBeInTheDocument();
    expect(append).not.toHaveBeenCalled();
  });
  it.each([1, 2])(
    'explains the per-step bound without budget metadata (turn limit %i)',
    (limit) => {
      const append = display(
        limited({ output_limit: { automaticAttempts: 1, maxAutomaticAttempts: limit } })
      );
      fireEvent.click(screen.getByText('Limit details'));
      expect(
        screen.getByText(
          `At most one automatic retry per step and ${limit} per turn. Another length limit in the same step stops the task.`
        )
      ).toBeVisible();
      expect(screen.queryByText(/Requested output budget:/)).not.toBeInTheDocument();
      expect(append).not.toHaveBeenCalled();
    }
  );
  it('shows both recovery attempts on a completed model turn', () => {
    display(
      limited({
        status: 'completed',
        stop_reason: undefined,
        output_limit: { automaticAttempts: 2, maxAutomaticAttempts: 2 },
      })
    );
    expect(screen.getByText(/recovery was used 2 times/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try continuing' })).not.toBeInTheDocument();
  });
  it('keeps continuation available after an immediate steer in the same turn', () => {
    display(limited(), [{ ...input, id: 'steer', metadata: { ...input.metadata, steer: true } }]);
    expect(screen.getByRole('button', { name: 'Try continuing' })).toBeInTheDocument();
  });
  it('does not offer an older task continuation after a new normal query or during a run', () => {
    const { unmount } = render(
      <GooseMessage
        sessionId="session"
        message={limited()}
        messages={[input, limited(), { ...input, id: 'new-query' }]}
        toolCallNotifications={new Map()}
        append={vi.fn()}
        isStreaming={false}
      />,
      { wrapper: IntlTestWrapper }
    );
    expect(screen.queryByRole('button', { name: 'Try continuing' })).not.toBeInTheDocument();
    unmount();
    display(limited(), [], true);
    expect(screen.queryByRole('button', { name: 'Try continuing' })).not.toBeInTheDocument();
  });
  it('never converts user cancellation into output recovery', () => {
    display(limited({ status: 'cancelled', user_requested_stop: true }));
    expect(screen.queryByRole('button', { name: 'Try continuing' })).not.toBeInTheDocument();
    expect(screen.queryByText(/length limit again/)).not.toBeInTheDocument();
  });
  it('distinguishes exhausted context from actual model output truncation', () => {
    display(limited({ status: 'failed', stop_reason: 'context_budget' }));
    expect(screen.getByText(/current context cannot leave enough room/)).toBeInTheDocument();
    expect(screen.queryByText(/length limit again/)).not.toBeInTheDocument();
  });
  it('does not call a different recovery error a repeated length limit', () => {
    display(limited({ status: 'failed', stop_reason: undefined }, 'Service rejected this request'));
    expect(screen.getByText('Service rejected this request')).toBeInTheDocument();
    expect(
      screen.getByText(/automatic response-length recovery did not finish/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/length limit again/)).not.toBeInTheDocument();
  });
});
