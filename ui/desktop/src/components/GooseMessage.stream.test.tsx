import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import type { Message } from '../types/message';
import GooseMessage from './GooseMessage';

const text = 'A received answer that should appear at a readable pace. '.repeat(2);
const message: Message = {
  id: 'paced-answer',
  role: 'assistant',
  created: 1,
  content: [{ type: 'text', text }],
  metadata: {
    userVisible: true,
    agentVisible: true,
    usage: { inputTokens: 1200, outputTokens: 340, totalTokens: 1540 },
  },
};
function answer(streaming: boolean, running: boolean) {
  return (
    <GooseMessage
      compactTools
      sessionId="paced-session"
      message={message}
      messages={[message]}
      toolCallNotifications={new Map()}
      append={() => {}}
      isStreaming={streaming}
      isTurnRunning={running}
    />
  );
}

describe('persistent answer actions', () => {
  it('shows actions once the caller has finished presenting the answer', async () => {
    const view = render(answer(true, true), { wrapper: IntlTestWrapper });
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    expect(screen.queryByText('Input 1.2k')).toBeNull();
    view.rerender(answer(false, false));
    expect(await screen.findByRole('button', { name: 'Copy' }, { timeout: 5000 })).toBeVisible();
    expect(screen.getByText('Input 1.2k')).toBeVisible();
  });
  it('does not expose a finished message footer while the current turn is still executing', async () => {
    const view = render(answer(false, true), { wrapper: IntlTestWrapper });
    expect(screen.getByText(text.trim())).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    expect(screen.queryByText('Input 1.2k')).toBeNull();
    view.rerender(answer(false, false));
    expect(screen.getByRole('button', { name: 'Copy' })).toBeVisible();
    expect(screen.getByText('Input 1.2k')).toBeVisible();
  });

  it('retries the original user prompt after streaming settles', () => {
    const prompt: Message = {
      id: 'prompt',
      role: 'user',
      created: 0,
      content: [{ type: 'text', text: 'Check the local fixture.' }],
      metadata: { userVisible: true, agentVisible: true },
    };
    const onRetryMessage = vi.fn();
    const view = (running: boolean) => (
      <GooseMessage
        compactTools
        sessionId="paced-session"
        message={message}
        messages={[prompt, message]}
        toolCallNotifications={new Map()}
        append={() => {}}
        isStreaming={false}
        isTurnRunning={running}
        onRetryMessage={onRetryMessage}
      />
    );
    const { rerender } = render(view(true), { wrapper: IntlTestWrapper });
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    rerender(view(false));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetryMessage).toHaveBeenCalledExactlyOnceWith('prompt', 'Check the local fixture.', 'retry');
  });
});
