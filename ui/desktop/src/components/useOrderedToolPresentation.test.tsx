import { act, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
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
  toolCall: {
    status: 'success',
    value: { name: 'pwsh', arguments: { command: 'node --test' } },
  },
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

it('settles replayed fragments sharing a message id even when the caller projects a fresh array per render', () => {
  const history = [
    user,
    assistant([{ type: 'text', text: 'Earlier fragment.' }]),
    assistant([{ type: 'text', text: 'A later, longer fragment of the same recorded message.' }]),
  ];
  let renders = 0;
  const { result, unmount } = renderHook(() => {
    renders++;
    return useOrderedToolPresentation(
      history.map((message) => ({ ...message })),
      false
    );
  });
  expect(result.current.messages).toEqual(history);
  expect(renders).toBeLessThan(5);
  unmount();
});

it('keeps replay cursors stable under repeated StrictMode history/stream/idle transitions', () => {
  const history = [
    user,
    ...Array.from({ length: 500 }, (_, index) =>
      assistant([
        { type: 'text' as const, text: 'fragment '.repeat((index % 9) + 1) },
        { ...command },
      ])
    ),
  ];
  const original = JSON.stringify(history);
  let renders = 0;
  const { result, rerender, unmount } = renderHook(
    ({ active, messages }) => {
      renders++;
      return useOrderedToolPresentation(
        messages.map((message) => ({ ...message })),
        active
      );
    },
    { initialProps: { active: false, messages: history }, wrapper: StrictMode }
  );
  for (let round = 0; round < 10; round++) {
    const messages = [
      ...history,
      assistant([{ type: 'text' as const, text: `New fragment ${round}.` }]),
    ];
    rerender({ active: true, messages });
    rerender({ active: false, messages });
    act(() => vi.advanceTimersByTime(1200));
    expect(result.current.pending).toBe(false);
    expect(
      getToolRequests(
        result.current.messages.flatMap((message) =>
          message.role === 'assistant' ? [message] : []
        )[0]
      )
    ).toHaveLength(1);
    expect(result.current.messages).toEqual(messages);
  }
  expect(renders).toBeLessThan(250);
  expect(JSON.stringify(history)).toBe(original);
  unmount();
});

describe('top-to-bottom streaming presentation', () => {
  it.each([1, 10, 50])(
    'bounds the whole received %i-operation burst, including cards, while preserving every prefix',
    (count) => {
      const { result, rerender, unmount } = renderHook(
        ({ messages, active }) => useOrderedToolPresentation(messages, active),
        { initialProps: { messages: [user], active: true } }
      );
      const content: Message['content'] = [
        { type: 'text', text: prose },
        ...Array.from({ length: count }, (_, index) => ({ ...command, id: `burst-${index}` })),
        { type: 'text', text: 'The received result.' },
      ];
      const messages = [user, assistant(content)];
      const original = JSON.stringify(messages);
      rerender({ messages, active: false });
      act(() => vi.advanceTimersByTime(96));
      expect(result.current.pending).toBe(true);
      const samples: number[] = [];
      for (let elapsed = 96; elapsed < 800 && result.current.pending; elapsed += 48) {
        const shown =
          result.current.messages.find((message) => message.id === 'assistant')?.content ?? [];
        const calls = shown.filter((part) => part.type === 'toolRequest');
        samples.push(calls.length);
        expect(calls.map((part) => part.id)).toEqual(
          Array.from({ length: calls.length }, (_, index) => `burst-${index}`)
        );
        if (calls.length) expect(shown[0]).toEqual(content[0]);
        act(() => vi.advanceTimersByTime(48));
      }
      expect(result.current.pending).toBe(false);
      expect(result.current.messages).toEqual(messages);
      if (count > 1) expect(samples.some((shown) => shown > 0 && shown < count)).toBe(true);
      expect(JSON.stringify(messages)).toBe(original);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it.each(['permission', 'cancelled', 'interrupted', 'hidden'])(
    'does not delay %s behind buffered prose',
    (kind) => {
      const { result, rerender, unmount } = renderHook(
        ({ messages }) => useOrderedToolPresentation(messages, true),
        { initialProps: { messages: [user] } }
      );
      const messages = [user, assistant([{ type: 'text', text: prose.repeat(20) }, command])];
      rerender({ messages });
      act(() => vi.advanceTimersByTime(48));
      expect(result.current.pending).toBe(true);
      if (kind === 'hidden') {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        act(() => document.dispatchEvent(new Event('visibilitychange')));
      } else {
        messages.push({
          ...assistant(
            kind === 'permission'
              ? [
                  {
                    type: 'actionRequired',
                    data: {
                      actionType: 'toolConfirmation',
                      id: 'approval',
                      toolName: 'test',
                      arguments: {},
                    },
                  },
                ]
              : [
                  {
                    type: 'systemNotification',
                    notificationType: 'turnTerminal',
                    msg: 'Stopped',
                    data: {
                      schema_version: 1,
                      session_id: 'session',
                      run_id: 'run',
                      terminal_message_id: 'terminal',
                      source_user_message_id: 'user',
                      status: kind,
                      checkpoint_id: null,
                      retry_strategy: 'not_available',
                      visible_text_available: true,
                      tool_action_count: 0,
                      copy_artifact_ref: null,
                      finished_at: new Date().toISOString(),
                    },
                  },
                ]
          ),
          id: 'urgent',
        });
        rerender({ messages: [...messages] });
      }
      expect(result.current.pending).toBe(false);
      expect(result.current.messages).toEqual(messages);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('catches up with a received burst without waiting for transport completion or reordering tools', () => {
    const { result, rerender, unmount } = renderHook(
      ({ messages }) => useOrderedToolPresentation(messages, true),
      {
        initialProps: { messages: [user] },
      }
    );
    const text = '完整文字🙂。'.repeat(2000);
    rerender({
      messages: [
        user,
        assistant([{ type: 'text', text }, command, { type: 'text', text: '后续结果' }]),
      ],
    });
    act(() => vi.advanceTimersByTime(96));
    expect(result.current.pending).toBe(true);
    expect(result.current.messages.flatMap(getToolRequests)).toHaveLength(0);
    act(() => vi.advanceTimersByTime(900));
    expect(result.current.pending).toBe(false);
    expect(result.current.messages[result.current.messages.length - 1]?.content).toEqual([
      { type: 'text', text },
      command,
      { type: 'text', text: '后续结果' },
    ]);
    unmount();
  });
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

  it('preserves many incremental batches and their ordering while older turns are loaded', () => {
    const history: Message[] = Array.from({ length: 120 }, (_, index) => [
      { ...user, id: `old-user-${index}` },
      {
        ...assistant([{ type: 'text', text: `Saved result ${index}` }]),
        id: `old-answer-${index}`,
      },
    ]).flat();
    const currentUser = { ...user, id: 'current-user' };
    const recent = history.slice(-40);
    const snapshots: Message[][] = [];
    const { result, rerender, unmount } = renderHook(
      ({ messages, active }) => {
        const presentation = useOrderedToolPresentation(messages, active);
        snapshots.push(presentation.messages);
        return presentation;
      },
      { initialProps: { messages: [...recent, currentUser], active: true } }
    );
    const visibleParts = () =>
      result.current.messages.find((message) => message.id === 'assistant')?.content ?? [];
    let thought = '';
    for (let batch = 0; batch < 20; batch += 1) {
      thought += `检查第${batch}段🙂。`;
      rerender({
        messages: [
          ...recent,
          currentUser,
          assistant([{ type: 'thinking', thinking: thought, signature: '' }]),
        ],
        active: true,
      });
      act(() => vi.advanceTimersByTime(48));
      const shown = visibleParts().find((part) => part.type === 'thinking');
      if (shown?.type === 'thinking') expect(thought.startsWith(shown.thinking)).toBe(true);
    }
    let firstText = '';
    let previousText = '';
    for (let batch = 0; batch < 30; batch += 1) {
      firstText += `说明第${batch}批处理结果🙂。`;
      rerender({
        messages: [
          ...recent,
          currentUser,
          assistant([
            { type: 'thinking', thinking: thought, signature: '' },
            { type: 'text', text: firstText },
          ]),
        ],
        active: true,
      });
      act(() => vi.advanceTimersByTime(48));
      const part = visibleParts().find((part) => part.type === 'text');
      const shown = part?.type === 'text' ? part.text : '';
      expect(firstText.startsWith(shown)).toBe(true);
      expect(shown.startsWith(previousText)).toBe(true);
      previousText = shown;
    }
    let finalText = '';
    const content = (): Message['content'] => [
      { type: 'thinking', thinking: thought, signature: '' },
      { type: 'text', text: firstText },
      command,
      { type: 'thinking', thinking: '根据真实回执整理结果🙂。', signature: '' },
      { type: 'text', text: finalText },
    ];
    for (let batch = 0; batch < 30; batch += 1) {
      finalText += `最终第${batch}批结论🙂。`;
      rerender({
        messages: [...history, currentUser, assistant(content())],
        active: true,
      });
      act(() => vi.advanceTimersByTime(48));
      expect(
        result.current.messages.find((message) => message.id === 'old-answer-0')?.content
      ).toEqual([{ type: 'text', text: 'Saved result 0' }]);
    }
    rerender({
      messages: [...history, currentUser, assistant(content())],
      active: false,
    });
    for (let frame = 0; frame < 600 && result.current.pending; frame += 1)
      act(() => vi.advanceTimersByTime(48));
    expect(result.current.pending).toBe(false);
    expect(visibleParts()).toEqual(content());
    for (const snapshot of snapshots) {
      const shown = snapshot.find((message) => message.id === 'assistant')?.content ?? [];
      if (shown.some((part) => part.type === 'toolRequest'))
        expect(shown[1]).toEqual({ type: 'text', text: firstText });
      if (shown.length > 4) expect(shown[2]).toEqual(command);
    }
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
