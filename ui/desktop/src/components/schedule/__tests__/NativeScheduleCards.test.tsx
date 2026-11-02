import type { ScheduleCatalogEntry } from '../../../acp/nativeSchedules';
import { OPEN_NATIVE_SCHEDULE } from '../scheduleEvents';
import { applyToolCall, applyToolCallUpdate } from '../../../acp/adapter/tools';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import { NativeScheduleCards } from '../NativeScheduleCards';
const catalog = vi.hoisted(() => ({
  snapshot: { records: [] as ScheduleCatalogEntry[], status: 'ready', readRequest: 5, readSettled: 5 },
  refresh: vi.fn(),
}));
vi.mock('../../../acp/nativeSchedules', () => ({
  useNativeSchedules: () => catalog.snapshot,
  refreshNativeSchedules: () => catalog.refresh(),
}));
import { createdNativeSchedules } from '../NativeScheduleCards';
import type { Message } from '../../../types/message';
const msg = (id: string, role: 'user' | 'assistant', content: unknown[]): Message =>
  ({
    id,
    role,
    content,
    created: 1,
    metadata: { userVisible: true, agentVisible: true },
  }) as Message;
const record = {
  id: 'task1',
  kind: 'every',
  title: 'Reminder',
  prompt: 'Report progress',
  everySeconds: 60,
  scheduledAt: '2026-11-01T00:00:00Z',
  deliveryMode: 'host',
  state: 'scheduled',
};
it('requires a successful structured receipt from the native create tool, only at the turn tail', () => {
  const human = msg('u', 'user', [{ type: 'text', text: 'create reminder' }]);
  const tool = msg('a', 'assistant', [
    {
      type: 'toolRequest',
      id: 'call1',
      toolCall: { status: 'success', value: { name: 'schedule_create', arguments: {} } },
    },
  ]);
  const result = msg('r', 'user', [
    {
      type: 'toolResponse',
      id: 'call1',
      toolResult: { status: 'success', value: { structuredContent: record } },
    },
  ]);
  const final = msg('f', 'assistant', [{ type: 'text', text: 'Created.' }]);
  const messages = [human, tool, result, final];
  expect(createdNativeSchedules(messages, tool)).toEqual([]);
  expect(createdNativeSchedules(messages, final)).toEqual([record]);
  const empty = msg('usage-only', 'assistant', []);
  expect(createdNativeSchedules([...messages, empty], empty)).toEqual([]);
  expect(createdNativeSchedules([...messages, empty], final)).toEqual([record]);
  result.content = [
    {
      type: 'toolResponse',
      id: 'call1',
      toolResult: { status: 'error', value: { structuredContent: record } },
    },
  ];
  expect(createdNativeSchedules(messages, final)).toEqual([]);
});
it('ignores assistant claims and JSON text which have no structured native receipt', () => {
  const human = msg('u', 'user', [{ type: 'text', text: 'create reminder' }]);
  const claim = msg('f', 'assistant', [{ type: 'text', text: 'The reminder has been created.' }]);
  expect(createdNativeSchedules([human, claim], claim)).toEqual([]);
  const tool = msg('a', 'assistant', [
    {
      type: 'toolRequest',
      id: 'call1',
      toolCall: { status: 'success', value: { name: 'schedule_create', arguments: {} } },
    },
  ]);
  const result = msg('r', 'user', [
    {
      type: 'toolResponse',
      id: 'call1',
      toolResult: {
        status: 'success',
        value: { content: [{ type: 'text', text: JSON.stringify(record) }] },
      },
    },
  ]);
  expect(createdNativeSchedules([human, tool, result, claim], claim)).toEqual([]);
});

it('accepts the real ACP adapter envelope used by a completed native schedule_create call', () => {
  const human = msg('u', 'user', [{ type: 'text', text: 'Create a task' }]);
  const state = { messages: [human], localSteerTextByMessageId: new Map<string, string>() };
  applyToolCall(state, {
    toolCallId: 'native-call',
    title: 'schedule_create',
    kind: 'execute',
    status: 'in_progress',
    rawInput: { title: 'Reminder', prompt: 'Report progress', every_seconds: 60 },
    _meta: {
      goose: {
        messageId: 'native-assistant',
        toolCall: { toolName: 'schedule_create', extensionName: 'harness' },
      },
    },
  });
  applyToolCallUpdate(state, {
    toolCallId: 'native-call',
    status: 'completed',
    rawOutput: record,
    _meta: { goose: { messageId: 'native-result' } },
  });
  const final = msg('f', 'assistant', [{ type: 'text', text: 'Created' }]);
  expect(createdNativeSchedules([...state.messages, final], final)).toEqual([record]);
});

it('marks a historical card deleted only after a newer successful native directory read', () => {
  const human = msg('u', 'user', [{ type: 'text', text: 'create reminder' }]);
  const tool = msg('a', 'assistant', [
    {
      type: 'toolRequest',
      id: 'call1',
      toolCall: { status: 'success', value: { name: 'schedule_create', arguments: {} } },
    },
  ]);
  const result = msg('r', 'user', [
    {
      type: 'toolResponse',
      id: 'call1',
      toolResult: { status: 'success', value: { structuredContent: record } },
    },
  ]);
  const final = msg('f', 'assistant', [{ type: 'text', text: 'Created.' }]);
  const props = { messages: [human, tool, result, final], message: final, running: false };
  catalog.snapshot = { records: [], status: 'ready', readRequest: 5, readSettled: 5 };
  const view = render(<NativeScheduleCards {...props} />, { wrapper: IntlTestWrapper });
  expect(catalog.refresh).toHaveBeenCalled();
  expect(screen.queryByText('Deleted')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open' })).toBeEnabled();
  expect(screen.getByText('Every 1 minutes')).toBeInTheDocument();
  catalog.snapshot = { records: [], status: 'error', readRequest: 6, readSettled: 5 };
  view.rerender(<NativeScheduleCards {...props} />);
  expect(screen.queryByText('Deleted')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open' })).toBeEnabled();
  catalog.snapshot = { records: [], status: 'ready', readRequest: 7, readSettled: 7 };
  view.rerender(<NativeScheduleCards {...props} />);
  expect(screen.getByText('Deleted')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Open' })).not.toBeInTheDocument();
  catalog.snapshot = { records: [], status: 'error', readRequest: 8, readSettled: 7 };
  view.rerender(<NativeScheduleCards {...props} />);
  expect(screen.getByText('Deleted')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Open' })).not.toBeInTheDocument();
  const opened = vi.fn();
  window.addEventListener(OPEN_NATIVE_SCHEDULE, opened);
  try {
    // Ended and paused tasks still have rules/history; only deletion removes Open.
    for (const status of ['active', 'paused', 'inactive'] as const) {
      catalog.snapshot = { records: [{ ...record, id: record.id as ScheduleCatalogEntry['id'], kind: 'every',
        sessionId: 'chat' as ScheduleCatalogEntry['sessionId'], status }],
        status: 'ready', readRequest: 9, readSettled: 9 };
      view.rerender(<NativeScheduleCards {...props} />);
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    }
    expect(opened).toHaveBeenCalledTimes(3);
  } finally { window.removeEventListener(OPEN_NATIVE_SCHEDULE, opened); }

});
