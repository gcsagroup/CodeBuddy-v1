import React, { useState, useEffect } from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
} from '../ui/dropdown-menu';
import type { ScheduledJobDto } from '@aaif/goose-sdk';
import { errorMessage } from '../../utils/conversionUtils';
import { defineMessages, useIntl } from '../../i18n';
import {
  buildCronForPeriod,
  describeCron,
  getQuarterStartMonth,
  getValidDayOfMonth,
  parseCron,
  quarterDayLimitByStartMonth,
  type Period,
} from '../../utils/cronSchedule';

const i18n = defineMessages({
  repeat: { id: 'cronPicker.repeat', defaultMessage: 'Repeat' },
  frequency: { id: 'cronPicker.frequency', defaultMessage: 'Run frequency' },
  daily: { id: 'cronPicker.daily', defaultMessage: 'Every day' },
  weekdays: { id: 'cronPicker.weekdays', defaultMessage: 'Weekdays' },
  weekly: { id: 'cronPicker.weekly', defaultMessage: 'Every week' },
  customFrequency: { id: 'cronPicker.customFrequency', defaultMessage: 'Custom' },
  time: { id: 'cronPicker.time', defaultMessage: 'Time' },
  every: { id: 'cronPicker.every', defaultMessage: 'Every' },
  mode: { id: 'cronPicker.mode', defaultMessage: 'Mode' },
  minute: { id: 'cronPicker.minute', defaultMessage: 'Minute' },
  hour: { id: 'cronPicker.hour', defaultMessage: 'Hour' },
  day: { id: 'cronPicker.day', defaultMessage: 'Day' },
  week: { id: 'cronPicker.week', defaultMessage: 'Week' },
  month: { id: 'cronPicker.month', defaultMessage: 'Month' },
  quarter: { id: 'cronPicker.quarter', defaultMessage: 'Quarter' },
  year: { id: 'cronPicker.year', defaultMessage: 'Year' },
  custom: { id: 'cronPicker.custom', defaultMessage: 'Custom cron' },
  cronExpression: { id: 'cronPicker.cronExpression', defaultMessage: 'Cron expression' },
  emptyCronError: {
    id: 'cronPicker.emptyCronError',
    defaultMessage: 'Cron expression cannot be empty',
  },
  invalidDayOfMonth: {
    id: 'cronPicker.invalidDayOfMonth',
    defaultMessage: 'Day must be between 1 and {max}',
  },
  inMonth: { id: 'cronPicker.inMonth', defaultMessage: 'in' },
  startingMonth: { id: 'cronPicker.startingMonth', defaultMessage: 'starting month' },
  january: { id: 'cronPicker.january', defaultMessage: 'January' },
  february: { id: 'cronPicker.february', defaultMessage: 'February' },
  march: { id: 'cronPicker.march', defaultMessage: 'March' },
  april: { id: 'cronPicker.april', defaultMessage: 'April' },
  may: { id: 'cronPicker.may', defaultMessage: 'May' },
  june: { id: 'cronPicker.june', defaultMessage: 'June' },
  july: { id: 'cronPicker.july', defaultMessage: 'July' },
  august: { id: 'cronPicker.august', defaultMessage: 'August' },
  september: { id: 'cronPicker.september', defaultMessage: 'September' },
  october: { id: 'cronPicker.october', defaultMessage: 'October' },
  november: { id: 'cronPicker.november', defaultMessage: 'November' },
  december: { id: 'cronPicker.december', defaultMessage: 'December' },
  onDay: { id: 'cronPicker.onDay', defaultMessage: 'on day' },
  on: { id: 'cronPicker.on', defaultMessage: 'on' },
  sunday: { id: 'cronPicker.sunday', defaultMessage: 'Sunday' },
  monday: { id: 'cronPicker.monday', defaultMessage: 'Monday' },
  tuesday: { id: 'cronPicker.tuesday', defaultMessage: 'Tuesday' },
  wednesday: { id: 'cronPicker.wednesday', defaultMessage: 'Wednesday' },
  thursday: { id: 'cronPicker.thursday', defaultMessage: 'Thursday' },
  friday: { id: 'cronPicker.friday', defaultMessage: 'Friday' },
  saturday: { id: 'cronPicker.saturday', defaultMessage: 'Saturday' },
  at: { id: 'cronPicker.at', defaultMessage: 'at' },
  atMinute: { id: 'cronPicker.atMinute', defaultMessage: 'at minute' },
  atSecond: { id: 'cronPicker.atSecond', defaultMessage: 'at second' },
  am: { id: 'cronPicker.am', defaultMessage: 'AM' },
  pm: { id: 'cronPicker.pm', defaultMessage: 'PM' },
});

interface CronPickerProps {
  schedule: ScheduledJobDto | null;
  onChange: (cron: string) => void;
  isValid: (valid: boolean) => void;
}

const to24Hour = (hour12: number, isPM: boolean): number => {
  if (hour12 === 12) {
    return isPM ? 12 : 0;
  }
  return isPM ? hour12 + 12 : hour12;
};

const to12Hour = (hour24: number): { hour: number; isPM: boolean } => {
  if (hour24 === 0) {
    return { hour: 12, isPM: false };
  }
  if (hour24 === 12) {
    return { hour: 12, isPM: true };
  }
  if (hour24 > 12) {
    return { hour: hour24 - 12, isPM: true };
  }
  return { hour: hour24, isPM: false };
};

export const CronPicker: React.FC<CronPickerProps> = ({ schedule, onChange, isValid }) => {
  const intl = useIntl();
  const [period, setPeriod] = useState<Period>('day');
  const [second, setSecond] = useState('0');
  const [minute, setMinute] = useState('0');
  const [hour12, setHour12] = useState(2);
  const [isPM, setIsPM] = useState(true);
  const [dayOfWeek, setDayOfWeek] = useState('1');
  const [dayOfMonth, setDayOfMonth] = useState('1');
  const [month, setMonth] = useState('1');
  const [quarterStartMonth, setQuarterStartMonth] = useState('1');
  const [customCron, setCustomCron] = useState('0 0 14 * * *');
  const [readableCron, setReadableCron] = useState('');
  const [hasCronError, setHasCronError] = useState(false);

  const getCurrentCron = (selectedPeriod: Period, validDayOfMonth: string | null): string =>
    buildCronForPeriod({
      period: selectedPeriod,
      second,
      minute,
      hour24: to24Hour(hour12, isPM),
      dayOfWeek,
      dayOfMonth: validDayOfMonth,
      month,
      quarterStartMonth,
      customCron,
    });

  useEffect(() => {
    const sourceCron = schedule?.cron || '';
    const parsed = parseCron(sourceCron);
    setPeriod(parsed.period);
    setSecond(parsed.second === '*' ? '0' : parsed.second);
    setMinute(parsed.minute === '*' ? '0' : parsed.minute);
    const hour24 = parsed.hour === '*' ? 14 : parseInt(parsed.hour, 10);
    const { hour, isPM: pm } = to12Hour(hour24);
    setHour12(hour);
    setIsPM(pm);
    setDayOfWeek(
      ['0', '1', '2', '3', '4', '5', '6'].includes(parsed.dayOfWeek) ? parsed.dayOfWeek : '1'
    );
    setDayOfMonth(parsed.dayOfMonth === '*' ? '1' : parsed.dayOfMonth);
    setMonth(parsed.month === '*' ? '1' : parsed.month);
    setQuarterStartMonth(getQuarterStartMonth(parsed.month) ?? '1');
    setCustomCron(sourceCron || '0 0 14 * * *');
  }, [schedule]);

  const maxDayOfMonth = period === 'quarter' ? quarterDayLimitByStartMonth[quarterStartMonth] : 31;

  useEffect(() => {
    const parsedDay = parseInt(dayOfMonth, 10);
    if (!Number.isNaN(parsedDay) && parsedDay > maxDayOfMonth) {
      setDayOfMonth(maxDayOfMonth.toString());
    }
  }, [dayOfMonth, maxDayOfMonth]);

  useEffect(() => {
    const validDayOfMonth = getValidDayOfMonth(dayOfMonth, maxDayOfMonth);

    if (
      (period === 'month' || period === 'quarter' || period === 'year') &&
      validDayOfMonth === null
    ) {
      onChange(getCurrentCron(period, null));
      isValid(false);
      setHasCronError(true);
      setReadableCron(intl.formatMessage(i18n.invalidDayOfMonth, { max: maxDayOfMonth }));
      return;
    }

    const cron = getCurrentCron(period, validDayOfMonth);
    onChange(cron);
    if (!cron.trim()) {
      isValid(false);
      setHasCronError(true);
      setReadableCron(intl.formatMessage(i18n.emptyCronError));
      return;
    }
    try {
      setReadableCron(describeCron(cron));
      setHasCronError(false);
      isValid(true);
    } catch (e) {
      isValid(false);
      setHasCronError(true);
      setReadableCron(errorMessage(e).replace(/^Error:\s*/, ''));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    period,
    second,
    minute,
    hour12,
    isPM,
    dayOfWeek,
    dayOfMonth,
    month,
    quarterStartMonth,
    maxDayOfMonth,
    customCron,
  ]);

  const selectClassName =
    'min-h-8 max-w-full rounded-lg border-0 bg-transparent px-2 py-1 text-sm text-text-secondary outline-none focus-visible:ring-2 focus-visible:ring-border-primary';

  return (
    <div className="rounded-2xl border border-border-primary px-4">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-border-primary py-2">
        <span className="text-sm text-text-primary">{intl.formatMessage(i18n.repeat)}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={intl.formatMessage(i18n.repeat)}
              className="flex min-h-8 items-center justify-end gap-2 rounded-lg px-1 py-1 text-sm text-text-secondary outline-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-primary"
            >
              {intl.formatMessage(
                period === 'day'
                  ? i18n.daily
                  : period === 'weekdays'
                    ? i18n.weekdays
                    : period === 'week'
                      ? i18n.weekly
                      : i18n.customFrequency
              )}
              <ChevronDown className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            sideOffset={6}
            className="w-44 rounded-2xl border-border-primary p-1"
          >
            <DropdownMenuLabel className="px-2.5 py-1.5 text-xs font-normal text-text-secondary">
              {intl.formatMessage(i18n.frequency)}
            </DropdownMenuLabel>
            <Menu.RadioGroup
              value={['day', 'weekdays', 'week'].includes(period) ? period : 'custom'}
              onValueChange={(value) => {
                const nextPeriod = value as Period;
                if (nextPeriod === 'custom' && period !== 'custom')
                  setCustomCron(
                    getCurrentCron(period, getValidDayOfMonth(dayOfMonth, maxDayOfMonth))
                  );
                setPeriod(nextPeriod);
              }}
            >
              {(['day', 'weekdays', 'week', 'custom'] as const).map((value) => (
                <Menu.RadioItem
                  key={value}
                  value={value}
                  className="relative flex cursor-default items-center justify-between rounded-lg px-2.5 py-1.5 text-sm text-text-primary outline-none data-[state=checked]:bg-background-secondary focus:bg-background-secondary"
                >
                  {intl.formatMessage(
                    value === 'day'
                      ? i18n.daily
                      : value === 'weekdays'
                        ? i18n.weekdays
                        : value === 'week'
                          ? i18n.weekly
                          : i18n.customFrequency
                  )}
                  <Menu.ItemIndicator>
                    <Check className="size-3.5" />
                  </Menu.ItemIndicator>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="space-y-3 py-3 [&>div]:flex-wrap [&>div]:justify-between">
        {period === 'custom' && (
          <div className="space-y-1">
            <label htmlFor="custom-cron-expression" className="text-sm">
              {intl.formatMessage(i18n.cronExpression)}
            </label>
            <input
              id="custom-cron-expression"
              type="text"
              value={customCron}
              onChange={(e) => setCustomCron(e.target.value)}
              className="w-full rounded-lg border border-border-primary bg-transparent px-3 py-2 text-sm outline-none focus:border-text-secondary"
            />
          </div>
        )}

        {period === 'quarter' && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm">{intl.formatMessage(i18n.startingMonth)}</span>
              <select
                value={quarterStartMonth}
                onChange={(e) => setQuarterStartMonth(e.target.value)}
                className={selectClassName}
              >
                <option value="1">{intl.formatMessage(i18n.january)}</option>
                <option value="2">{intl.formatMessage(i18n.february)}</option>
                <option value="3">{intl.formatMessage(i18n.march)}</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm">{intl.formatMessage(i18n.onDay)}</span>
              <input
                type="number"
                min="1"
                max={maxDayOfMonth}
                value={dayOfMonth}
                onChange={(e) => setDayOfMonth(e.target.value)}
                className="w-16 px-2 py-1 border rounded"
              />
            </div>
          </div>
        )}

        {period === 'year' && (
          <div className="flex items-center gap-2">
            <span className="text-sm">{intl.formatMessage(i18n.inMonth)}</span>
            <select
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className={selectClassName}
            >
              <option value="1">{intl.formatMessage(i18n.january)}</option>
              <option value="2">{intl.formatMessage(i18n.february)}</option>
              <option value="3">{intl.formatMessage(i18n.march)}</option>
              <option value="4">{intl.formatMessage(i18n.april)}</option>
              <option value="5">{intl.formatMessage(i18n.may)}</option>
              <option value="6">{intl.formatMessage(i18n.june)}</option>
              <option value="7">{intl.formatMessage(i18n.july)}</option>
              <option value="8">{intl.formatMessage(i18n.august)}</option>
              <option value="9">{intl.formatMessage(i18n.september)}</option>
              <option value="10">{intl.formatMessage(i18n.october)}</option>
              <option value="11">{intl.formatMessage(i18n.november)}</option>
              <option value="12">{intl.formatMessage(i18n.december)}</option>
            </select>
          </div>
        )}

        {(period === 'month' || period === 'year') && (
          <div className="flex items-center gap-2">
            <span className="text-sm">{intl.formatMessage(i18n.onDay)}</span>
            <input
              type="number"
              min="1"
              max={maxDayOfMonth}
              value={dayOfMonth}
              onChange={(e) => setDayOfMonth(e.target.value)}
              className="w-14 rounded-lg border border-border-primary bg-transparent px-2 py-1 text-sm"
            />
          </div>
        )}

        {period === 'week' && (
          <div className="flex items-center gap-2">
            <span className="text-sm">{intl.formatMessage(i18n.on)}</span>
            <select
              value={dayOfWeek}
              onChange={(e) => setDayOfWeek(e.target.value)}
              className={selectClassName}
            >
              <option value="0">{intl.formatMessage(i18n.sunday)}</option>
              <option value="1">{intl.formatMessage(i18n.monday)}</option>
              <option value="2">{intl.formatMessage(i18n.tuesday)}</option>
              <option value="3">{intl.formatMessage(i18n.wednesday)}</option>
              <option value="4">{intl.formatMessage(i18n.thursday)}</option>
              <option value="5">{intl.formatMessage(i18n.friday)}</option>
              <option value="6">{intl.formatMessage(i18n.saturday)}</option>
            </select>
          </div>
        )}

        {(period === 'day' ||
          period === 'weekdays' ||
          period === 'week' ||
          period === 'month' ||
          period === 'quarter' ||
          period === 'year') && (
          <div className="flex items-center gap-2">
            <span className="mr-auto text-sm text-text-primary">
              {intl.formatMessage(i18n.time)}
            </span>
            <input
              type="time"
              aria-label={intl.formatMessage(i18n.time)}
              value={`${to24Hour(hour12, isPM).toString().padStart(2, '0')}:${minute.padStart(2, '0')}`}
              onChange={(event) => {
                if (!event.target.value) return;
                const [hour, minute] = event.target.value.split(':').map(Number);
                const time = to12Hour(hour);
                setHour12(time.hour);
                setIsPM(time.isPM);
                setMinute(String(minute));
              }}
              className="rounded-lg border-0 bg-transparent px-2 py-1 text-sm tabular-nums text-text-secondary outline-none focus-visible:ring-2 focus-visible:ring-border-primary"
            />
          </div>
        )}

        {period === 'hour' && (
          <div className="flex items-center gap-2">
            <span className="text-sm">{intl.formatMessage(i18n.atMinute)}</span>
            <input
              type="number"
              min="0"
              max="59"
              value={minute}
              onChange={(e) => setMinute(e.target.value)}
              className="w-16 px-2 py-1 border rounded"
            />
          </div>
        )}

        {period === 'minute' && (
          <div className="flex items-center gap-2">
            <span className="text-sm">{intl.formatMessage(i18n.atSecond)}</span>
            <input
              type="number"
              min="0"
              max="59"
              value={second}
              onChange={(e) => setSecond(e.target.value)}
              className="w-16 px-2 py-1 border rounded"
            />
          </div>
        )}
      </div>

      {(period === 'custom' || hasCronError) && (
        <div
          className={`pb-3 text-xs ${hasCronError ? 'text-text-danger' : 'text-text-secondary'}`}
          aria-live="polite"
        >
          {readableCron}
        </div>
      )}
    </div>
  );
};
