import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../types/message';
import { getToolRequests } from '../types/message';
import { useOrderedToolPresentation } from './useOrderedToolPresentation';

const user: Message = {
  id: 'user',
  role: 'user',
  created: 1,
  metadata: { userVisible: true, agentVisible: true },
  content: [{ type: 'text', text: 'Build the example' }],
};
const prose = '先说明当前进展，再展示接下来的命令。'.repeat(8);
const command: Message['content'][number] = {
  type: 'toolRequest',
  id: 'command',
  toolCall: { status: 'success', value: { name: 'pwsh', arguments: { command: 'node --test' } } },
};
function assistant(content: Message['content']): Message {
  return { ...user, id: 'assistant', role: 'assistant', content };
}
const publicText = (messages: Message[]) =>
  messages
    .flatMap((message) => message.content)
    .filter((content) => content.type === 'text')
    .map((content) => content.text)
    .join('');

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'performance',
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ],
  });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('top-to-bottom streaming presentation', () => {
  it('does not expose a later command or prose before the preceding text has finished presenting', () => {
    const snapshots: Message[][] = [];
    const { result, rerender, unmount } = renderHook(
      ({ messages }) => {
        const presentation = useOrderedToolPresentation(messages, true);
        snapshots.push(presentation.messages);
        return presentation;
      },
      { initialProps: { messages: [user] } }
    );
    rerender({ messages: [user, assistant([{ type: 'text', text: prose }])] });
    act(() => vi.advanceTimersByTime(96));
    const partial = publicText(result.current.messages).replace(
      user.content[0].type === 'text' ? user.content[0].text : '',
      ''
    );
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(prose.length);
    rerender({
      messages: [
        user,
        assistant([
          { type: 'text', text: prose },
          command,
          { type: 'text', text: '命令之后的说明' },
        ]),
      ],
    });
    expect(result.current.messages.flatMap(getToolRequests)).toHaveLength(0);
    for (let frame = 0; frame < 160 && result.current.pending; frame += 1)
      act(() => vi.advanceTimersByTime(48));
    expect(result.current.pending).toBe(false);
    for (const messages of snapshots) {
      const content = messages.find((message) => message.id === 'assistant')?.content ?? [];
      if (content.some((part) => part.type === 'toolRequest'))
        expect(content[0]).toEqual({ type: 'text', text: prose });
      if (content.some((part) => part.type === 'text' && part.text.startsWith('命令之后')))
        expect(content[1]).toEqual(command);
    }
    unmount();
  });

  it('preserves thinking, prose, command and later thinking in their original sequence', () => {
    const { result, rerender, unmount } = renderHook(
      ({ messages }) => useOrderedToolPresentation(messages, true),
      { initialProps: { messages: [user] } }
    );
    const content: Message['content'] = [
      { type: 'thinking', thinking: '先分析', signature: '' },
      { type: 'text', text: prose },
      command,
      { type: 'thinking', thinking: '根据回执继续分析', signature: '' },
      { type: 'text', text: '最后的说明' },
    ];
    rerender({ messages: [user, assistant(content)] });
    act(() => vi.advanceTimersByTime(96));
    expect(
      result.current.messages
        .find((message) => message.id === 'assistant')
        ?.content.map((part) => part.type)
    ).toEqual(['thinking']);
    for (let frame = 0; frame < 160 && result.current.pending; frame += 1) {
      const shown =
        result.current.messages.find((message) => message.id === 'assistant')?.content ?? [];
      if (shown.some((part) => part.type === 'toolRequest'))
        expect(shown[1]).toEqual({ type: 'text', text: prose });
      act(() => vi.advanceTimersByTime(48));
    }
    expect(result.current.messages.find((message) => message.id === 'assistant')?.content).toEqual(
      content
    );
    unmount();
  });

  it('does not flush a pending command ahead of text when transport becomes idle', () => {
    const { result, rerender, unmount } = renderHook(
      ({ messages, active }) => useOrderedToolPresentation(messages, active),
      { initialProps: { messages: [user], active: true } }
    );
    const messages = [user, assistant([{ type: 'text', text: prose }, command])];
    rerender({ messages, active: true });
    act(() => vi.advanceTimersByTime(96));
    rerender({ messages, active: false });
    expect(result.current.pending).toBe(true);
    expect(result.current.messages.flatMap(getToolRequests)).toHaveLength(0);
    for (let frame = 0; frame < 160 && result.current.pending; frame += 1)
      act(() => vi.advanceTimersByTime(48));
    expect(result.current.messages.flatMap(getToolRequests)).toHaveLength(1);
    expect(publicText(result.current.messages)).toContain(prose);
    unmount();
  });
});
