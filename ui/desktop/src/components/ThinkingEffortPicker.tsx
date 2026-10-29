import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, ChevronRight, LoaderCircle } from 'lucide-react';
import { defineMessages, useIntl } from '../i18n';
import {
  acpReadModelDisplaySettings,
  acpSaveThinkingEffort,
  type ModelDisplaySettings,
} from '../acp/providers';
import type { ModelThinkingSettings, ThinkingEffort } from '../types/providers';

const i18n = defineMessages({
  title: { id: 'thinkingEffortPicker.title', defaultMessage: 'Thinking effort' },
  off: { id: 'thinkingEffortPicker.off', defaultMessage: 'None' },
  on: { id: 'thinkingEffortPicker.on', defaultMessage: 'On' },
  minimal: { id: 'thinkingEffortPicker.minimal', defaultMessage: 'Minimal' },
  low: { id: 'thinkingEffortPicker.low', defaultMessage: 'Low' },
  medium: { id: 'thinkingEffortPicker.medium', defaultMessage: 'Medium' },
  high: { id: 'thinkingEffortPicker.high', defaultMessage: 'High' },
  xhigh: { id: 'thinkingEffortPicker.xhigh', defaultMessage: 'Extra high' },
  max: { id: 'thinkingEffortPicker.max', defaultMessage: 'Maximum' },
  error: {
    id: 'thinkingEffortPicker.error',
    defaultMessage: 'Could not save thinking effort. Try again.',
  },
  loading: { id: 'thinkingEffortPicker.loading', defaultMessage: 'Reading…' },
  readFailed: {
    id: 'thinkingEffortPicker.readFailed',
    defaultMessage: 'Could not read model settings',
  },
  context: { id: 'thinkingEffortPicker.context', defaultMessage: 'Context window' },
  unavailable: { id: 'thinkingEffortPicker.unavailable', defaultMessage: 'Not provided' },
  noControls: { id: 'thinkingEffortPicker.noControls', defaultMessage: 'No verified controls' },
  budget: {
    id: 'thinkingEffortPicker.budget',
    defaultMessage: 'Current budget; model capacity unconfirmed',
  },
});

type ThinkingEffortPickerProps = {
  settings: ModelThinkingSettings;
  onChange: (value: ThinkingEffort) => Promise<void> | void;
  disabled?: boolean;
  error?: boolean;
  showLabel?: boolean;
  openOnHover?: boolean;
  popupSide?: 'top' | 'left';
  presentation?: 'menu' | 'slider';
  modelLabel?: string;
  onSelectModel?: () => void;
  triggerContent?: ReactNode;
};

export function ThinkingEffortPicker(props: ThinkingEffortPickerProps) {
  return props.presentation === 'slider' ? (
    <ThinkingEffortSlider {...props} />
  ) : (
    <ThinkingEffortMenu {...props} />
  );
}

function effortIndex(options: ThinkingEffort[], value: ThinkingEffort | null) {
  return value ? Math.max(0, options.indexOf(value)) : 0;
}

function ThinkingEffortSlider({
  settings,
  onChange,
  disabled = false,
  error = false,
  modelLabel,
  onSelectModel,
  triggerContent,
}: ThinkingEffortPickerProps) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const [rangeValue, setRangeValue] = useState(() => effortIndex(settings.options, settings.value));
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const alive = useRef(true);
  const draggingNow = useRef(false);
  const inFlight = useRef(false);
  const queued = useRef<ThinkingEffort | null>(null);
  const confirmed = useRef(settings.value);
  const change = useRef(onChange);
  const openingModelList = useRef(false);
  change.current = onChange;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      queued.current = null;
    };
  }, []);
  useEffect(() => {
    confirmed.current = settings.value;
    if (!inFlight.current && !draggingNow.current)
      setRangeValue(effortIndex(settings.options, settings.value));
  }, [settings.value, settings.options]);
  useEffect(() => {
    if (!open && !inFlight.current) setRangeValue(effortIndex(settings.options, confirmed.current));
  }, [open, settings.options]);

  const label = (effort: ThinkingEffort) =>
    intl.formatMessage(settings.toggle && effort !== 'off' ? i18n.on : i18n[effort]);
  const commit = (effort: ThinkingEffort) => {
    if (disabled) return;
    queued.current = effort;
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    void (async () => {
      try {
        while (alive.current && queued.current !== null) {
          const next = queued.current;
          queued.current = null;
          if (next === confirmed.current) continue;
          try {
            await change.current(next);
            confirmed.current = next;
          } catch {
            if (alive.current && queued.current === null && !draggingNow.current)
              setRangeValue(effortIndex(settings.options, confirmed.current));
          }
        }
      } finally {
        inFlight.current = false;
        if (alive.current) setSaving(false);
      }
    })();
  };
  if (!settings.options.length || !settings.value) return null;
  const title = intl.formatMessage(i18n.title);
  if (settings.options.length === 1)
    return (
      <span className="shrink-0 px-1 text-xs text-text-secondary" title={title}>
        {label(settings.value)}
      </span>
    );
  const index = Math.min(settings.options.length - 1, Math.max(0, Math.round(rangeValue)));
  const fraction = Math.min(1, Math.max(0, rangeValue / (settings.options.length - 1)));
  const position = `calc(${fraction * 100}% + ${6 - fraction * 12}px)`;
  const release = (value: string) => {
    draggingNow.current = false;
    setDragging(false);
    const at = Math.round(Number(value));
    const effort = settings.options[at];
    if (effort) setRangeValue(at);
    if (effort) commit(effort);
  };
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          draggingNow.current = false;
          setDragging(false);
        }
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-busy={saving || disabled}
          aria-label={`${title}: ${label(settings.value)}`}
          title={title}
          className="flex min-h-7 min-w-0 max-w-full cursor-default items-center gap-1 rounded-md px-1 text-xs text-text-secondary transition-colors hover:text-text-primary disabled:opacity-60"
        >
          {triggerContent}
          <span className="inline-grid shrink-0 text-left">
            <span className="col-start-1 row-start-1 flex items-center gap-1">
              {label(settings.value)}
              {saving ? (
                <LoaderCircle className="size-3 shrink-0 animate-spin" aria-hidden="true" />
              ) : (
                <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
              )}
            </span>
            {/* Reserve space after the arrow, keeping the visible label and arrow together. */}
            {settings.options.map((effort) => (
              <span
                key={effort}
                aria-hidden="true"
                className="invisible col-start-1 row-start-1 flex items-center gap-1"
              >
                {label(effort)}
                <span className="size-3 shrink-0" />
              </span>
            ))}
          </span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          data-thinking-effort-card
          updatePositionStrategy="always"
          side="top"
          align="center"
          sideOffset={6}
          collisionPadding={12}
          onCloseAutoFocus={(event) => {
            if (openingModelList.current) {
              event.preventDefault();
              openingModelList.current = false;
            }
          }}
          className="z-[110] w-[min(14rem,calc(100vw-2rem))] origin-[var(--radix-popover-content-transform-origin)] rounded-xl border border-border-primary bg-background-primary p-3 text-text-primary shadow-md data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-bottom-1 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 duration-150 motion-reduce:animate-none"
        >
          <div className="relative top-1 flex min-h-4 items-center justify-between gap-3 px-1.5 text-[11px] text-text-secondary">
            <span>{title}</span>
            <span className="font-medium text-text-primary">{label(settings.options[index])}</span>
          </div>
          <div className="relative mt-1 mb-1 h-[22px] rounded-full has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-1.5 top-1/2 h-1 -translate-y-1/2 rounded-full bg-text-secondary/15"
            />
            <div
              aria-hidden="true"
              className={`pointer-events-none absolute left-1.5 top-1/2 h-1 -translate-y-1/2 rounded-full bg-blue-500 transition-[width] ease-out motion-reduce:transition-none ${dragging ? 'duration-75' : 'duration-150'}`}
              style={{ width: `calc(${fraction * 100}% - ${fraction * 12}px)` }}
            />
            {settings.options.map((effort, at) => {
              const part = at / (settings.options.length - 1);
              return (
                <span
                  key={effort}
                  aria-hidden="true"
                  className="pointer-events-none absolute top-[17px] h-[3px] w-px -translate-x-1/2 bg-text-secondary/40"
                  style={{ left: `calc(${part * 100}% + ${6 - part * 12}px)` }}
                />
              );
            })}
            <div
              aria-hidden="true"
              className={`pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-border-primary bg-background-primary shadow-sm transition-[left] ease-out motion-reduce:transition-none ${dragging ? 'duration-75' : 'duration-150'}`}
              style={{ left: position }}
            />
            <input
              type="range"
              min={0}
              max={settings.options.length - 1}
              step="any"
              value={rangeValue}
              aria-label={title}
              aria-valuetext={label(settings.options[index])}
              aria-busy={saving}
              disabled={disabled}
              className="absolute inset-0 m-0 h-full w-full cursor-default touch-none appearance-none opacity-0 [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:cursor-default [&::-webkit-slider-thumb]:appearance-none"
              onPointerDown={() => {
                draggingNow.current = true;
                setDragging(true);
              }}
              onChange={(event) => {
                setRangeValue(Number(event.target.value));
              }}
              onPointerUp={(event) => release(event.currentTarget.value)}
              onPointerCancel={() => {
                draggingNow.current = false;
                setDragging(false);
                setRangeValue(effortIndex(settings.options, confirmed.current));
              }}
              onKeyDown={(event) => {
                const delta = ['ArrowLeft', 'ArrowDown', 'PageDown'].includes(event.key)
                  ? -1
                  : ['ArrowRight', 'ArrowUp', 'PageUp'].includes(event.key)
                    ? 1
                    : 0;
                if (!delta && event.key !== 'Home' && event.key !== 'End') return;
                event.preventDefault();
                setRangeValue(
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? settings.options.length - 1
                      : Math.min(
                          settings.options.length - 1,
                          Math.max(0, Math.round(Number(event.currentTarget.value)) + delta)
                        )
                );
              }}
              onKeyUp={(event) => {
                if (
                  [
                    'ArrowLeft',
                    'ArrowRight',
                    'ArrowUp',
                    'ArrowDown',
                    'Home',
                    'End',
                    'PageUp',
                    'PageDown',
                  ].includes(event.key)
                )
                  release(event.currentTarget.value);
              }}
            />
          </div>
          {modelLabel &&
            (onSelectModel ? (
              <button
                type="button"
                className="mt-1 flex w-full items-center justify-center gap-1 text-[10px] text-text-secondary hover:text-text-primary"
                onClick={() => {
                  openingModelList.current = true;
                  setOpen(false);
                  onSelectModel();
                }}
              >
                <span className="truncate">{modelLabel}</span>
                <ChevronRight className="size-3 shrink-0" aria-hidden="true" />
              </button>
            ) : (
              <p className="mt-1 truncate text-center text-[10px] text-text-secondary">
                {modelLabel}
              </p>
            ))}
          {error && (
            <p role="alert" className="pt-2 text-xs text-text-danger">
              {intl.formatMessage(i18n.error)}
            </p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ThinkingEffortMenu({
  settings,
  onChange,
  disabled = false,
  error = false,
  showLabel = false,
  openOnHover = false,
  popupSide = 'top',
}: ThinkingEffortPickerProps) {
  const intl = useIntl();
  const name = useId();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const hoverCloseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retainOptions = () => clearTimeout(hoverCloseTimer.current);
  const leaveOptions = () => {
    if (!openOnHover) return;
    retainOptions();
    hoverCloseTimer.current = setTimeout(() => setOpen(false), 150);
  };
  useEffect(() => () => clearTimeout(hoverCloseTimer.current), []);
  if (!settings.options.length || !settings.value)
    return showLabel ? (
      <div className="flex min-h-9 items-center justify-between gap-3 px-2 text-sm text-text-secondary">
        <span>{intl.formatMessage(i18n.title)}</span>
        <span>{intl.formatMessage(i18n.noControls)}</span>
      </div>
    ) : null;
  const label = (effort: ThinkingEffort) =>
    intl.formatMessage(settings.toggle && effort !== 'off' ? i18n.on : i18n[effort]);
  const title = intl.formatMessage(i18n.title);
  const canChoose = settings.options.length > 1;
  const select = async (effort: ThinkingEffort) => {
    if (inFlight.current || disabled || effort === settings.value) return;
    inFlight.current = true;
    setSaving(true);
    try {
      await onChange(effort);
      if (!openOnHover) setOpen(false);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  if (!canChoose)
    return (
      <span
        className={
          showLabel
            ? 'flex min-h-9 w-full items-center justify-between gap-3 px-2 text-sm text-text-secondary'
            : 'flex shrink-0 items-center text-xs text-text-secondary'
        }
        title={title}
      >
        {showLabel && <span>{title}</span>}
        {label(settings.value)}
      </span>
    );
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled || saving}
          aria-label={`${title}: ${label(settings.value)}`}
          title={title}
          onMouseEnter={
            openOnHover && !disabled && !saving
              ? () => {
                  retainOptions();
                  setOpen(true);
                }
              : undefined
          }
          onMouseLeave={leaveOptions}
          className={`${showLabel ? 'min-h-9 w-full gap-2 rounded-lg px-2 py-2 text-sm' : 'min-h-7 shrink-0 gap-1 rounded-md px-1 text-xs'} ${open ? 'bg-background-secondary' : ''} flex items-center text-text-secondary hover:bg-background-secondary disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring`}
        >
          {showLabel && <span className="flex-1 text-left">{title}</span>}
          <span>{label(settings.value)}</span>
          {showLabel ? (
            <ChevronRight className="size-3" aria-hidden="true" />
          ) : (
            <ChevronDown className="size-3" aria-hidden="true" />
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          data-thinking-effort-card
          onMouseEnter={retainOptions}
          onMouseLeave={leaveOptions}
          side={popupSide}
          align={popupSide === 'left' ? 'end' : 'start'}
          collisionPadding={12}
          sideOffset={6}
          className="z-[110] w-40 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-xl border border-border-primary bg-background-primary p-1.5 text-text-primary shadow-md"
        >
          <fieldset disabled={disabled || saving} className="grid gap-1">
            <legend className="sr-only">{title}</legend>
            {settings.options.map((effort) => (
              <label
                key={effort}
                className={`flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-background-secondary has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring ${settings.value === effort ? 'bg-background-secondary' : ''} ${saving ? 'opacity-60' : ''}`}
              >
                <input
                  type="radio"
                  name={name}
                  value={effort}
                  checked={settings.value === effort}
                  onChange={() => {
                    void select(effort).catch(() => {});
                  }}
                  className="sr-only"
                />
                <span className="flex-1">{label(effort)}</span>
                {settings.value === effort && (
                  <Check className="size-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
                )}
              </label>
            ))}
          </fieldset>
          {error && (
            <p role="alert" className="px-3 pt-2 text-xs text-text-danger">
              {intl.formatMessage(i18n.error)}
            </p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function ModelThinkingMenu({
  provider,
  model,
  showLabel = false,
  popupSide = 'top',
  showContextWindow = false,
  initialSettings,
  readSettings = acpReadModelDisplaySettings,
  onEffortChanged,
  onSavingChange,
  presentation,
  modelLabel,
  onSelectModel,
  triggerContent,
  disabled,
}: {
  provider: string | null;
  model: string | null;
  showLabel?: boolean;
  popupSide?: 'top' | 'left';
  showContextWindow?: boolean;
  initialSettings?: ModelDisplaySettings;
  readSettings?: typeof acpReadModelDisplaySettings;
  onEffortChanged?: (settings: ModelDisplaySettings) => Promise<void> | void;
  onSavingChange?: (saving: boolean) => void;
  presentation?: 'menu' | 'slider';
  modelLabel?: string;
  onSelectModel?: () => void;
  triggerContent?: ReactNode;
  disabled?: boolean;
}) {
  const intl = useIntl();
  const identity = JSON.stringify([provider, model]);
  const [loaded, setLoaded] = useState<{
    identity: string;
    details: ModelDisplaySettings;
  } | null>(() => (initialSettings ? { identity, details: initialSettings } : null));
  const [error, setError] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const current = useRef(identity);
  current.current = identity;
  useEffect(() => {
    current.current = identity;
    setLoaded(initialSettings ? { identity, details: initialSettings } : null);
    setError(false);
    setReadFailed(false);
    let active = true;
    if (provider && model && !initialSettings)
      void readSettings(provider, model)
        .then((value) => {
          if (active) setLoaded({ identity, details: value });
        })
        .catch(() => {
          if (active) setReadFailed(true);
        });
    return () => {
      active = false;
      if (current.current === identity) current.current = '';
    };
  }, [provider, model, identity, initialSettings, readSettings]);
  const details = loaded?.identity === identity ? loaded.details : null;
  const settings = details?.thinking;
  const unresolved = settings?.options.length === 0 && details?.contextSource === 'fallback';
  if (!provider || !model) return null;
  if (triggerContent && (!settings?.value || settings.options.length < 2 || unresolved))
    return (
      <button
        type="button"
        onClick={onSelectModel}
        disabled={disabled}
        title={readFailed ? intl.formatMessage(i18n.readFailed) : modelLabel}
        aria-label={modelLabel}
        className="flex min-h-7 min-w-0 max-w-full cursor-default items-center gap-1 rounded-md px-1 text-xs text-text-secondary transition-colors hover:text-text-primary disabled:opacity-60"
      >
        {triggerContent}
        <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
      </button>
    );
  return (
    <>
      {(!settings || unresolved) && showLabel && (
        <div
          role="status"
          className="flex min-h-9 items-center justify-between gap-3 px-2 text-sm text-text-secondary"
        >
          <span>{intl.formatMessage(i18n.title)}</span>
          <span>
            {intl.formatMessage(
              unresolved ? i18n.unavailable : readFailed ? i18n.readFailed : i18n.loading
            )}
          </span>
        </div>
      )}
      {details && settings && !unresolved && (
        <ThinkingEffortPicker
          key={identity}
          settings={settings}
          presentation={presentation}
          modelLabel={modelLabel}
          onSelectModel={onSelectModel}
          triggerContent={triggerContent}
          disabled={disabled}
          showLabel={showLabel}
          openOnHover={showLabel}
          popupSide={popupSide}
          error={error}
          onChange={async (value) => {
            setError(false);
            onSavingChange?.(true);
            try {
              try {
                await acpSaveThinkingEffort(value, provider, model);
              } catch (failure) {
                if (current.current === identity) setError(true);
                throw failure;
              }
              const updated = { ...details, thinking: { ...settings, value } };
              if (current.current === identity) setLoaded({ identity, details: updated });
              await onEffortChanged?.(updated);
            } finally {
              onSavingChange?.(false);
            }
          }}
        />
      )}
      {showContextWindow && (
        <div className="flex min-h-9 items-center justify-between gap-3 px-2 text-sm text-text-secondary">
          <span>{intl.formatMessage(i18n.context)}</span>
          <span>
            {details?.contextWindow
              ? `${intl.formatNumber(details.contextWindow)} tokens`
              : intl.formatMessage(details || readFailed ? i18n.unavailable : i18n.loading)}
          </span>
        </div>
      )}
      {showContextWindow && details?.contextSource === 'fallback' && (
        <p className="px-2 pt-1 text-xs text-text-secondary">{intl.formatMessage(i18n.budget)}</p>
      )}
    </>
  );
}
