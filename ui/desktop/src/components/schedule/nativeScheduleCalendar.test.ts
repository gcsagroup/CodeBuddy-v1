import { expect, it } from 'vitest';
import { monthlyCalendar } from './nativeScheduleCalendar';
import type { ScheduleRecord } from '../../acp/nativeSchedules';
const monthly = (expression: string) => ({ kind: 'cron', expression }) as ScheduleRecord;
it('reopens the native canonical monthly date ranges without losing dates', () => {
  expect(monthlyCalendar(monthly('7 17 6,11,17-18,24,31 * *'))).toEqual({
    days: [6, 11, 17, 18, 24, 31],
    time: '17:07:00',
  });
  expect(monthlyCalendar(monthly('0 9 1-31/5 * *'))?.days).toEqual([1, 6, 11, 16, 21, 26, 31]);
  for (const expression of ['0 9 1 * 1', '0 9 1 2 *', '*/5 9 1 * *', '0 9 0 * *'])
    expect(monthlyCalendar(monthly(expression))).toBeUndefined();
});
