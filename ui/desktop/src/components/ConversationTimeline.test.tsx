import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import type { Message } from '../types/message';
import { ConversationTimeline } from './ConversationTimeline';
import type { ScrollAreaHandle } from './ui/scroll-area';

afterEach(() => vi.unstubAllGlobals());

it('highlights every visible turn including clipped edges and clears turns after scrolling away', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const viewport = document.createElement('div');
  const content = document.createElement('div');
  viewport.append(content);
  document.body.append(viewport);
  Object.defineProperty(viewport, 'clientHeight', { value: 200 });
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 400, 200);
  let offset = 0;
  const messages: Message[] = Array.from({ length: 4 }, (_, index) => {
    const anchor = document.createElement('section');
    anchor.dataset.chatTurnId = `turn-${index}`;
    anchor.getBoundingClientRect = () => new DOMRect(0, index * 100 - 50 - offset, 400, 100);
    content.append(anchor);
    return {
      id: `turn-${index}`,
      role: 'user',
      created: index,
      content: [{ type: 'text', text: `Question ${index}` }],
      metadata: { userVisible: true, agentVisible: true },
    };
  });
  const handle: ScrollAreaHandle = {
    viewportRef: { current: viewport },
    scrollToBottom: vi.fn(),
    scrollToPosition: vi.fn(),
    isAtBottom: () => false,
    isFollowing: false,
  };
  const view = render(
    <ConversationTimeline
      messages={messages}
      scrollRef={{ current: handle }}
      onNavigate={vi.fn()}
    />,
    { wrapper: IntlTestWrapper }
  );
  const visibleTurns = () =>
    screen
      .getAllByRole('button')
      .map((button, index) => (button.dataset.visible === 'true' ? index : -1))
      .filter((index) => index >= 0);
  try {
    await waitFor(() => expect(visibleTurns()).toEqual([0, 1, 2]));
    offset = 150;
    fireEvent.scroll(viewport);
    await waitFor(() => expect(visibleTurns()).toEqual([2, 3]));
    expect(view.container.querySelectorAll('[aria-current]')).toHaveLength(1);
  } finally {
    view.unmount();
    viewport.remove();
  }
});

it('indexes visible user turns only and navigates by stable message id', () => {
  const messages: Message[] = [
    {
      id: 'u1',
      role: 'user',
      created: 1,
      content: [{ type: 'text', text: 'First request' }],
      metadata: { userVisible: true, agentVisible: true },
    },
    {
      id: 'internal',
      role: 'user',
      created: 2,
      content: [{ type: 'text', text: 'Internal context' }],
      metadata: { userVisible: false, agentVisible: true },
    },
    {
      id: 'a1',
      role: 'assistant',
      created: 3,
      content: [{ type: 'text', text: 'Visible reply' }],
      metadata: { userVisible: true, agentVisible: true },
    },
    {
      id: 'u2',
      role: 'user',
      created: 4,
      content: [{ type: 'text', text: 'Second request' }],
      metadata: { userVisible: true, agentVisible: true },
    },
  ];
  const onNavigate = vi.fn();
  render(
    <ConversationTimeline
      messages={messages}
      scrollRef={{ current: null }}
      onNavigate={onNavigate}
    />,
    { wrapper: IntlTestWrapper }
  );
  expect(screen.getAllByRole('button')).toHaveLength(2);
  expect(screen.queryByRole('button', { name: /Internal context/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Go to turn 1: First request' }));
  expect(onNavigate).toHaveBeenCalledWith('u1');
});
