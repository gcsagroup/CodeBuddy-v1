import { describe, expect, it } from 'vitest';
import { buildCronForPeriod, parseCron } from './cronSchedule';

describe('friendly cron conversion', () => {
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
