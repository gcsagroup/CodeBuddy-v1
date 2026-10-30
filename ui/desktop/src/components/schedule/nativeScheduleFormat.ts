import { monthlyCalendar } from './nativeScheduleCalendar';
import type { IntlShape } from 'react-intl';
import type { ScheduleRecord } from '../../acp/nativeSchedules';
import { nativeScheduleMessages as m } from './nativeScheduleMessages';
export function formatNativeSchedule(record: ScheduleRecord, intl: IntlShape): string {
  switch (record.kind) {
    case 'after':
    case 'at':
      return intl.formatMessage(m.once);
    case 'every':
      return intl.formatMessage(m.every, { count: record.everySeconds / 60 });
    case 'daily':
      return intl.formatMessage(m.daily, { time: record.time.slice(0, 8), zone: record.timeZone });
    case 'weekly':
      return intl.formatMessage(m.weekly, {
        days: record.weekdays.join(', '),
        time: record.time.slice(0, 8),
        zone: record.timeZone,
      });
    case 'cron': {
      const monthly = monthlyCalendar(record);
      if (monthly)
        return intl.formatMessage(m.monthly, {
          days: monthly.days.join(', '),
          time: monthly.time.slice(0, 5),
          zone: record.timeZone,
        });
      return `${record.expression} (${record.timeZone})`;
    }
  }
}
