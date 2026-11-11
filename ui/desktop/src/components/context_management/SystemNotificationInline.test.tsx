import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import type { Message, SystemNotificationContent } from '../../types/message';
import { getInlineSystemNotification, SystemNotificationInline } from './SystemNotificationInline';

describe('durable compaction receipts', () => {
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
