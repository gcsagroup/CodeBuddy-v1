import { describe, expect, it } from 'vitest';
import { buildCronForPeriod, parseCron } from './cronSchedule';

describe('friendly cron conversion', () => {
  it('recognizes weekday schedules without converting legacy custom schedules', () => {
    expect(parseCron('0 30 9 * * 1-5')).toMatchObject({
      period: 'weekdays',
      minute: '30',
      hour: '9',
    });
    expect(parseCron('30 9 * * 1,2,3,4,5')).toMatchObject({ period: 'weekdays' });
    expect(parseCron('0 30 9 * * 1,3,5')).toMatchObject({ period: 'custom' });
  });
  it('round-trips a local weekly schedule with seconds', () => {
    const cron = buildCronForPeriod({
      period: 'week',
      second: '0',
      minute: '30',
      hour24: 9,
      dayOfWeek: '1',
      dayOfMonth: null,
      month: '*',
      quarterStartMonth: '1',
      customCron: '',
    });
    expect(cron).toBe('0 30 9 * * 1');
    expect(parseCron(cron)).toMatchObject({
      period: 'week',
      minute: '30',
      hour: '9',
      dayOfWeek: '1',
    });
  });

  it('accepts legacy five-field cron as friendly daily input', () => {
    expect(parseCron('30 9 * * *')).toMatchObject({ period: 'day', second: '0', minute: '30' });
  });
});
