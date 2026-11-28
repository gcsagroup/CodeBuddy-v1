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
function answer(streaming: boolean, running: boolean, current = message) {
  return (
    <GooseMessage
      compactTools
      sessionId="paced-session"
      message={current}
      messages={[current]}
      toolCallNotifications={new Map()}
      append={() => {}}
      isStreaming={streaming}
      isTurnRunning={running}
    />
  );
}

describe('persistent answer actions', () => {
  it('renders received chat text without word wrappers and keeps its paragraph when settling', () => {
    const view = render(answer(true, true), { wrapper: IntlTestWrapper });
    const paragraph = view.container.querySelector('.codepro-assistant-prose p');
    expect(paragraph).toHaveTextContent(text.trim());
    expect(view.container.querySelector('.codepro-incoming-word')).toBeNull();
    view.rerender(answer(false, false));
    expect(view.container.querySelector('.codepro-assistant-prose p')).toBe(paragraph);
    expect(view.container.querySelector('.codepro-incoming-word')).toBeNull();
  });

  it('still switches live code from plain rendering to settled highlighting', () => {
    const code: Message = { ...message, content: [{ type: 'text', text: '```js\nconst n = 1;\n```' }] };
    const view = render(answer(true, true, code), { wrapper: IntlTestWrapper });
    expect(view.container.querySelector('[data-plain-code] code')).toHaveTextContent('const n = 1;');
    view.rerender(answer(false, false, code));
    expect(view.container.querySelector('[data-plain-code]')).toBeNull();
    expect(view.container.querySelector('code')).toHaveTextContent('const n = 1;');
  });

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
