import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { createAcpSessionNotificationAdapter } from './sessionNotificationAdapter';
import { IntlTestWrapper } from '../i18n/test-utils';
import { SystemNotificationInline } from '../components/context_management/SystemNotificationInline';
import type { SubagentLifecycle } from '../types/subagentLifecycle';

const fact = (phase: 'start' | 'end', activation = 'first'): SubagentLifecycle => ({
  type: 'subagent_lifecycle',
  schema_version: 1,
  event_id: `${activation}:${phase}`,
  session_id: 'parent',
  child_session_id: 'child',
  activation_id: activation,
  phase,
  label: 'Code review',
  created_at: 10,
});

it('keeps start and end once across replay and reuse, separate from model-visible replies and active-run state', () => {
  const adapter = createAcpSessionNotificationAdapter();
  const apply = (data: SubagentLifecycle) =>
    adapter.apply({
      sessionId: 'parent',
      update: {
        sessionUpdate: 'session_info_update',
        _meta: { goose: { subagentLifecycle: { ...data } } },
      },
    });
  apply(fact('start'));
  apply(fact('end'));
  apply(fact('start'));
  apply(fact('end'));
  apply(fact('start', 'second'));
  expect(adapter.getMessages().map((message) => message.id)).toEqual([
    'first:start',
    'first:end',
    'second:start',
  ]);
  expect(
    adapter
      .getMessages()
      .every(
        (message) =>
          !message.metadata.agentVisible &&
          !message.content.some((content) => content.type === 'text')
      )
  ).toBe(true);
  const count = adapter.getMessages().length;
  expect(apply({ ...fact('start', 'foreign'), session_id: 'another-parent' })).toEqual([]);
  expect(adapter.getMessages()).toHaveLength(count);
});

it('opens the exact native child from the main-chat caption', () => {
  const open = vi.fn();
  window.addEventListener('codebuddy:open-subagent-conversation', open);
  try {
    render(
      <SystemNotificationInline
        notification={{ notificationType: 'inlineMessage', msg: '', data: fact('end') }}
      />,
      { wrapper: IntlTestWrapper }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Code review ended' }));
    expect(open.mock.calls[0][0].detail).toEqual({
      parentSessionId: 'parent',
      childSessionId: 'child',
      title: 'Code review',
    });
    expect(screen.queryByText(/completed/i)).toBeNull();
  } finally {
    window.removeEventListener('codebuddy:open-subagent-conversation', open);
  }
});

it('places an admitted interruption at its original display anchor during live delivery and replay', () => {
  const prior = {
    id: 'prior-output',
    role: 'assistant' as const,
    created: 1,
    content: [{ type: 'text' as const, text: 'prior-output' }],
    metadata: { userVisible: true, agentVisible: true },
  };
  for (const initial of [[], [prior]]) {
    const adapter = createAcpSessionNotificationAdapter(initial);
    const text = (id: string, role: 'user' | 'assistant', afterMessageId?: string) =>
      adapter.apply({
        sessionId: 'parent',
        update: {
          sessionUpdate: role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
          messageId: id,
          content: { type: 'text', text: id },
          _meta: {
            goose: {
              messageId: id,
              ...(afterMessageId ? { presentation: { afterMessageId } } : {}),
            },
          },
        },
      });
    if (!initial.length) text('prior-output', 'assistant');
    for (const activation of ['first', 'second'])
      adapter.apply({
        sessionId: 'parent',
        update: {
          sessionUpdate: 'session_info_update',
          _meta: { goose: { subagentLifecycle: fact('end', activation) } },
        },
      });
    // Native cancellation finishes before the next prompt is admitted. Only
    // this explicit presentation anchor restores the earlier click position.
    text('stop-request', 'user', 'prior-output');
    text('stop-request', 'user', 'prior-output');
    text('stopped-reply', 'assistant');
    expect(adapter.getMessages().map((message) => message.id)).toEqual([
      'prior-output',
      'stop-request',
      'first:end',
      'second:end',
      'stopped-reply',
    ]);
    expect(adapter.getMessages()[1].metadata).not.toHaveProperty('pendingDelivery');
    text('other-request', 'user', 'foreign-chat-anchor');
    expect(adapter.getMessages().slice(-1)[0]?.id).toBe('other-request');
  }
});
