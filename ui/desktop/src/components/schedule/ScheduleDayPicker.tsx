import { useIntl } from '../../i18n';
import { nativeScheduleMessages as m } from './nativeScheduleMessages';

export function ScheduleDayPicker({
  monthly = false,
  value,
  onChange,
}: {
  monthly?: boolean;
  value: number[];
  onChange: (days: number[]) => void;
}) {
  const intl = useIntl();
  return (
    <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-2 gap-y-2 py-2 text-sm">
      <span className="shrink-0 whitespace-nowrap">
        {intl.formatMessage(monthly ? m.monthDays : m.weekdays)}
      </span>
      <div
        role="group"
        aria-label={intl.formatMessage(monthly ? m.monthDays : m.weekdays)}
        className="ml-auto grid w-[196px] max-w-full shrink-0 grid-cols-7 gap-y-1"
      >
        {Array.from({ length: monthly ? 31 : 7 }, (_, index) => {
          const day = index + 1;
          const selected = value.includes(day);
          const date = new Date(Date.UTC(2026, 9, 26 + index));
          const label = monthly
            ? String(day)
            : intl.formatDate(date, { weekday: 'narrow', timeZone: 'UTC' });
          const fullLabel = monthly
            ? intl.formatMessage(m.monthDay, { day })
            : intl.formatDate(date, { weekday: 'long', timeZone: 'UTC' });
          return (
            <button
              type="button"
              key={day}
              aria-label={fullLabel}
              aria-pressed={selected}
              className={`mx-auto flex h-7 w-full max-w-7 items-center justify-center rounded-full border text-xs tabular-nums outline-none transition-colors hover:bg-background-secondary focus-visible:ring-1 focus-visible:ring-border-secondary ${selected ? 'border-border-secondary bg-background-secondary text-text-primary' : 'border-transparent text-text-secondary'}`}
              onClick={() => {
                if (selected && value.length === 1) return;
                onChange(
                  selected
                    ? value.filter((item) => item !== day)
                    : [...value, day].sort((a, b) => a - b)
                );
              }}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
