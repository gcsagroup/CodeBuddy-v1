import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import type { Message, SystemNotificationContent } from '../../types/message';
import { groupCompactionFailures, getInlineSystemNotification, SystemNotificationInline } from './SystemNotificationInline';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../acp/acpConnection', () => ({ getAcpControlClient: async () => ({ extMethod: request }) }));

it('automatically resolves a historical receipt and can retry a failed read', async () => {
  request.mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce({
    title: 'Airplane', task: 'Build the game', result: 'Keyboard controls are wired.', files: ['game.js'], fileCount: 1,
  });
  const notice = { notificationType: 'inlineMessage' as const, msg: '旧完成提示', data: {
    event: 'managed_turn_result', outcome: 'completed', requestId: 'turn-a', sessionId: 'plane',
  } };
  render(<SystemNotificationInline sessionId="main" notification={notice} />, { wrapper: IntlTestWrapper });
  expect(screen.queryByText('旧完成提示')).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Keyboard controls are wired.')).toBeVisible();
  expect(screen.getByText(/game\.js/)).toBeVisible();
  expect(request).toHaveBeenLastCalledWith('_codebuddy/main-conversation/overview', {
    sessionId: 'main', detailSessionId: 'plane', requestId: 'turn-a',
  });
});

it('displays a delivered snapshot immediately without another read', () => {
  request.mockClear();
  render(<SystemNotificationInline sessionId="main" notification={{ notificationType: 'inlineMessage', msg: '', data: {
    event: 'managed_turn_result', outcome: 'completed', requestId: 'turn-b', sessionId: 'disk', title: 'Disk',
    brief: { title: 'Disk', task: 'Upload', result: 'Upload is available.', files: ['upload.ts'], fileCount: 1 },
  } }} />, { wrapper: IntlTestWrapper });
  expect(screen.getByRole('article', { name: 'Project brief · Disk' })).toHaveTextContent('CodeBuddy');
  expect(screen.getByText('Upload is available.')).toBeVisible();
  expect(screen.getByText(/upload\.ts/)).toBeVisible();
  expect(request).not.toHaveBeenCalled();
});

describe('durable compaction receipts', () => {
  it('groups matching automatic failures and preserves manual attempts and receipts', () => {
    const failure = (id: string, trigger: string): Message => ({
      id, role: 'assistant', created: 1, metadata: { userVisible: true, agentVisible: false },
      content: [{ type: 'systemNotification', notificationType: 'progressMessage', msg: '', data: {
        schema_version: 1, event: 'compaction_lifecycle', operation_id: id, status: 'failed', trigger,
        diagnostic: { code: 'TRANSPORT' }, started_at: '2026-11-05T00:00:00Z', error: 'Connection error',
      } }],
    });
    const receipts = [failure('a', 'auto'), failure('b', 'auto'), failure('c', 'manual')];
    const cards = groupCompactionFailures(receipts);
    expect(cards.map(card => card.id)).toEqual(['a', 'c']);
    expect(getInlineSystemNotification(receipts[0])?.data).not.toHaveProperty('repeatCount');
    render(<SystemNotificationInline notification={getInlineSystemNotification(cards[0])!} />, { wrapper: IntlTestWrapper });
    expect(screen.getByRole('status')).toHaveTextContent('× 2');
  });

  it('keeps the failure reason in collapsed details instead of a second alert', () => {
    render(<SystemNotificationInline notification={{ notificationType: 'progressMessage', msg: '', data: {
      schema_version: 1, event: 'compaction_lifecycle', operation_id: 'op', status: 'failed', trigger: 'manual',
      started_at: '2026-11-05T00:00:00Z', error: 'summarization truncated at the token cap (incomplete checkpoint)',
    } }} />, { wrapper: IntlTestWrapper });
    expect(screen.getByText('View details').closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText(/summarization truncated/).closest('details')).not.toHaveAttribute('open');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it.each([
    ['completed', 'auto', 'Context automatically compacted'],
    ['completed', 'manual', 'Context compacted'],
    ['failed', 'manual', 'Context compaction failed. The previous context is preserved.'],
    ['cancelled', 'auto', 'Context compaction cancelled. The previous context is preserved.'],
  ])('renders %s %s from structured facts', (status, trigger, expected) => {
    const notification: SystemNotificationContent & { type: 'systemNotification' } = { type: 'systemNotification', notificationType: 'progressMessage', msg: 'untrusted display text', data: {
      schema_version: 1, event: 'compaction_lifecycle', operation_id: 'op', status, trigger, started_at: '2026-11-05T00:00:00Z',
    } };
    const message: Message = { role: 'assistant', created: 1, content: [notification], metadata: { userVisible: true, agentVisible: false } };
    expect(getInlineSystemNotification(message)).toBe(notification);
    render(<SystemNotificationInline notification={notification} />, { wrapper: IntlTestWrapper });
    expect(screen.getByRole('status')).toHaveTextContent(expected);
    expect(screen.queryByText('untrusted display text')).not.toBeInTheDocument();
  });
});
