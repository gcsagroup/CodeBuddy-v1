import { useMemo, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown } from 'lucide-react';
import { useIntl } from '../../i18n';
import { nativeScheduleMessages as m } from './nativeScheduleMessages';

const zones = (
  Intl as typeof Intl & { supportedValuesOf(key: 'timeZone'): string[] }
).supportedValuesOf('timeZone');

function zoneLabel(zone: string, locale: string, at: string) {
  const date = new Date(at);
  const part = (localeName: string, timeZoneName: 'long' | 'longOffset') =>
    new Intl.DateTimeFormat(localeName, { timeZone: zone, timeZoneName })
      .formatToParts(date)
      .find((value) => value.type === 'timeZoneName')?.value ?? zone;
  const raw = part('en', 'longOffset');
  const offset = raw === 'GMT' ? 'UTC+00:00' : raw.replace('GMT', 'UTC');
  const match = offset.match(/UTC([+-])(\d{2}):(\d{2})/);
  const minutes = match
    ? (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '-' ? -1 : 1)
    : 0;
  return { zone, label: `${offset} · ${part(locale, 'long')}`, minutes };
}

export function ScheduleTimeZonePicker({
  value,
  at,
  disabled,
  onChange,
}: {
  value: string;
  at: string;
  disabled: boolean;
  onChange: (zone: string) => void;
}) {
  const intl = useIntl();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const system = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const selected = useMemo(() => zoneLabel(value, intl.locale, at), [value, intl.locale, at]);
  // Build localized names only when opened, not on every countdown tick.
  const options = useMemo(
    () =>
      open
        ? [...new Set([value, system, 'UTC', ...zones])]
            .map((zone) => zoneLabel(zone, intl.locale, at))
            .sort((a, b) =>
              a.zone === b.zone
                ? 0
                : a.zone === system
                  ? -1
                  : b.zone === system
                    ? 1
                    : a.zone === 'UTC'
                      ? -1
                      : b.zone === 'UTC'
                        ? 1
                        : a.minutes - b.minutes || a.zone.localeCompare(b.zone)
            )
        : [],
    [open, value, system, intl.locale, at]
  );
  const text = (item: typeof selected) =>
    item.label + (item.zone === system ? ` ${intl.formatMessage(m.systemZone)}` : '');
  const visible = options.filter((item) =>
    `${text(item)} ${item.zone.replace(/_/g, ' ')}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase())
  );
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setQuery('');
      }}
    >
      <Popover.Trigger asChild>
        <button
          ref={trigger}
          type="button"
          disabled={disabled}
          aria-label={intl.formatMessage(m.zone)}
          className="ml-auto flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-background-secondary"
        >
          <span className="truncate" title={value}>
            {text(selected)}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-text-secondary" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionBoundary={trigger.current?.closest('[data-schedule-panel]') ?? undefined}
          collisionPadding={8}
          className="z-50 w-[296px] max-w-[min(calc(100vw-32px),var(--radix-popover-content-available-width))] rounded-xl border border-border-primary bg-background-primary p-1.5 text-text-primary shadow-lg data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <input
            aria-label={intl.formatMessage(m.searchZone)}
            placeholder={intl.formatMessage(m.searchZone)}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="mb-1 w-full rounded-lg border border-border-primary bg-transparent px-2 py-1.5 text-xs outline-none focus:border-border-secondary"
          />
          <div
            className="max-h-[min(240px,calc(var(--radix-popover-content-available-height)-52px))] overflow-y-auto overscroll-contain"
            role="listbox"
            aria-label={intl.formatMessage(m.zone)}
          >
            {visible.map((item) => (
              <button
                key={item.zone}
                type="button"
                role="option"
                aria-selected={value === item.zone}
                title={`${text(item)} · ${item.zone}`}
                onClick={() => {
                  onChange(item.zone);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-background-secondary focus-visible:bg-background-secondary focus-visible:outline-none"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate leading-4">{text(item)}</span>
                  <span className="block text-[10px] leading-[14px] text-text-secondary">
                    {item.zone}
                  </span>
                </span>
                {value === item.zone && <Check className="size-3.5 shrink-0" />}
              </button>
            ))}
            {!visible.length && (
              <p className="px-2.5 py-3 text-sm text-text-secondary">
                {intl.formatMessage(m.noZones)}
              </p>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
