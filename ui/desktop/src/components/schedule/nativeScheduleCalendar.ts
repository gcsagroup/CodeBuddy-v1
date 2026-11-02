import type { ScheduleRecord } from '../../acp/nativeSchedules';

// Presentation of the native five-field monthly subset only. General Cron rules
// remain intact; the Host still validates and computes every actual occurrence.
export function monthlyCalendar(record: ScheduleRecord) {
  if (record.kind !== 'cron') return undefined;
  const fields = record.expression.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const [minute, hour, dates, month, weekday] = fields;
  if (
    !/^\d+$/.test(minute) ||
    Number(minute) > 59 ||
    !/^\d+$/.test(hour) ||
    Number(hour) > 23 ||
    month !== '*' ||
    weekday !== '*'
  )
    return undefined;
  const selected = new Set<number>();
  for (const field of dates.split(',')) {
    const match = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(field);
    if (!match) return undefined;
    const start = match[1] === '*' ? 1 : Number(match[1]);
    const end = match[1] === '*' ? 31 : match[2] ? Number(match[2]) : start;
    const step = match[3] ? Number(match[3]) : 1;
    if (start < 1 || end > 31 || start > end || step < 1) return undefined;
    for (let day = start; day <= end; day += step) selected.add(day);
  }
  return {
    days: [...selected].sort((a, b) => a - b),
    time: `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:00`,
  };
}
