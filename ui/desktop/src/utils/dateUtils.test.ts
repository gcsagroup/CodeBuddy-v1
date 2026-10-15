import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionListItem } from '../acp/sessions';
import { groupSessionsByDate } from './dateUtils';

function session(id: string, updatedAt: string): SessionListItem {
  return { id, updatedAt } as SessionListItem;
}

describe('groupSessionsByDate', () => {
  afterEach(() => vi.useRealTimers());

  it('formats relative and calendar date headings with the active locale', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-05T12:00:00'));

    const groups = groupSessionsByDate(
      [session('yesterday', '2026-09-04T10:00:00'), session('older', '2026-09-03T10:00:00')],
      'zh-CN'
    );

    expect(groups.map((group) => group.label)).toEqual([
      new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' }).format(-1, 'day'),
      new Intl.DateTimeFormat('zh-CN', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      }).format(new Date('2026-09-03T00:00:00')),
    ]);
  });
});
