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
