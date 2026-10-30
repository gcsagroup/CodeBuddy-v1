import { useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Clock3 } from 'lucide-react';
import { useIntl } from '../../i18n';
import { nativeScheduleMessages as m } from './nativeScheduleMessages';

export function ScheduleTimePicker({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [hour, minute, seconds = '00'] = value.split(':');
  const selected = [hour, minute];
  const choose = (column: number, part: string) => {
    onChange(`${column === 0 ? part : hour}:${column === 1 ? part : minute}:${seconds}`);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          ref={trigger}
          type="button"
          disabled={disabled}
          aria-label={intl.formatMessage(m.time)}
          className="ml-auto inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-sm tabular-nums hover:bg-background-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-secondary"
        >
          {Number(seconds) === 0 ? `${hour}:${minute}` : value}
          <Clock3 className="size-3.5 text-text-secondary" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={content}
          align="end"
          sideOffset={4}
          collisionBoundary={trigger.current?.closest('[data-schedule-panel]') ?? undefined}
          collisionPadding={8}
          aria-label={intl.formatMessage(m.time)}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            // The portal's available height is resolved after mount. Center the
            // selected values after layout, rather than measuring a zero-height list.
            requestAnimationFrame(() => {
              const lists = content.current?.querySelectorAll<HTMLElement>('[role=listbox]');
              lists?.forEach((list, index) => {
                const option = list.querySelector<HTMLElement>('[aria-selected=true]');
                if (!option) return;
                list.scrollTop = option.offsetTop - (list.clientHeight - option.offsetHeight) / 2;
                if (index === 0) option.focus({ preventScroll: true });
              });
            });
          }}
          className="z-50 flex w-[136px] gap-1 rounded-xl border border-border-primary bg-background-primary p-1 text-text-primary shadow-lg data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          {[24, 60].map((count, column) => (
            <div
              key={column}
              role="listbox"
              aria-label={intl.formatMessage(column === 0 ? m.hours : m.minutes)}
              className="relative max-h-[min(224px,calc(var(--radix-popover-content-available-height)-12px))] min-w-0 flex-1 overflow-y-auto overscroll-contain"
            >
              {Array.from({ length: count }, (_, index) => {
                const part = String(index).padStart(2, '0');
                const active = part === selected[column];
                return (
                  <button
                    key={part}
                    type="button"
                    role="option"
                    aria-selected={active}
                    tabIndex={active ? 0 : -1}
                    onClick={() => choose(column, part)}
                    onKeyDown={(event) => {
                      let next: number;
                      if (event.key === 'ArrowDown') next = (index + 1) % count;
                      else if (event.key === 'ArrowUp') next = (index + count - 1) % count;
                      else if (event.key === 'Home') next = 0;
                      else if (event.key === 'End') next = count - 1;
                      else return;
                      event.preventDefault();
                      choose(column, String(next).padStart(2, '0'));
                      const option = event.currentTarget.parentElement?.children[next] as
                        | HTMLElement
                        | undefined;
                      option?.focus();
                    }}
                    className={`flex h-8 w-full items-center justify-center rounded-lg border text-xs tabular-nums outline-none hover:bg-background-secondary focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-secondary ${active ? 'border-border-secondary bg-background-secondary' : 'border-transparent'}`}
                  >
                    {part}
                  </button>
                );
              })}
            </div>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
