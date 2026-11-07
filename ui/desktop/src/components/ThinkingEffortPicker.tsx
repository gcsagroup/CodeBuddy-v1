import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronRight, LoaderCircle } from 'lucide-react';
import { DropdownChevron } from './ui/DropdownChevron';
import './ThinkingEffortSlider.css';
import { defineMessages, useIntl } from '../i18n';
import {
  acpReadModelDisplaySettings,
  acpSaveThinkingEffort,
  readThinkingDraft,
  stageThinkingEffort,
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
  modelMenuOpen?: boolean;
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
  modelMenuOpen = false,
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
  // Match the native range's 20px thumb so the visual handle follows the pointer.
  const position = `calc(${fraction * 100}% + ${10 - fraction * 20}px)`;
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
          className="flex h-8 min-w-0 max-w-full cursor-default items-center gap-1 rounded-md px-1.5 text-xs text-text-secondary transition-colors hover:bg-background-secondary hover:text-text-primary disabled:opacity-60"
        >
          {triggerContent}
          <span className="inline-grid shrink-0 text-left">
            <span className="col-start-1 row-start-1 flex items-center gap-1">
              <span className="@max-[24rem]/composer:hidden">{label(settings.value)}</span>
              {saving ? (
                <LoaderCircle className="size-3 shrink-0 animate-spin" aria-hidden="true" />
              ) : (
                <DropdownChevron open={open || modelMenuOpen} className="size-3" />
              )}
            </span>
            {/* Reserve space after the arrow, keeping the visible label and arrow together. */}
            {settings.options.map((effort) => (
              <span
                key={effort}
                aria-hidden="true"
                className="invisible col-start-1 row-start-1 flex items-center gap-1 @max-[24rem]/composer:hidden"
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
          data-effort={settings.options[index]}
          style={{
            '--effort-lightness': `${60 - fraction * 17}%`,
            '--effort-flow-opacity': 0.4 + fraction * 0.4,
          } as CSSProperties}
          updatePositionStrategy="always"
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          onCloseAutoFocus={(event) => {
            if (openingModelList.current) {
              event.preventDefault();
              openingModelList.current = false;
            }
          }}
          aria-label={title}
          className="composer-menu-surface thinking-effort-popover z-[110] w-[min(15.5rem,calc(100vw-1.5rem))] origin-[var(--radix-popover-content-transform-origin)] rounded-2xl border border-border-primary p-3 text-text-primary data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-bottom-1 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 duration-150 motion-reduce:animate-none"
        >
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="text-text-secondary">{title}</span>
            <div className="flex items-center gap-1.5">
              {saving && (
                <LoaderCircle
                  className="size-3 animate-spin text-text-secondary motion-reduce:animate-none"
                  aria-hidden="true"
                />
              )}
              <span className="thinking-effort-level rounded-md px-1.5 py-0.5 font-medium">
                {label(settings.options[index])}
              </span>
            </div>
          </div>
          {modelLabel &&
            (onSelectModel ? (
              <button
                type="button"
                className="mt-1 flex max-w-full items-center gap-0.5 rounded text-xs leading-4 text-text-secondary transition-colors hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                title={modelLabel}
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
              <p className="mt-1 truncate text-xs leading-4 text-text-secondary" title={modelLabel}>
                {modelLabel}
              </p>
            ))}
          <div className="thinking-effort-track" data-dragging={dragging || undefined}>
            <div aria-hidden="true" className="thinking-effort-rail" />
            <div aria-hidden="true" className="thinking-effort-fill" style={{ width: position }} />
            {settings.options.map((effort, at) => {
              const part = at / (settings.options.length - 1);
              return (
                <span
                  key={effort}
                  aria-hidden="true"
                  className="thinking-effort-stop"
                  data-active={at <= index || undefined}
                  style={{ left: `calc(${part * 100}% + ${10 - part * 20}px)` }}
                />
              );
            })}
            <div aria-hidden="true" className="thinking-effort-thumb" style={{ left: position }} />
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
              className="thinking-effort-input"
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
            <DropdownChevron open={open} className="size-3" />
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
  deferUntilSubmit = false,
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
  modelMenuOpen = false,
  disabled,
}: {
  deferUntilSubmit?: boolean;
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
  modelMenuOpen?: boolean;
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
  const draft = deferUntilSubmit && provider && model ? readThinkingDraft(provider, model) : undefined;
  const settings = details?.thinking && draft && details.thinking.options.includes(draft)
    ? { ...details.thinking, value: draft } : details?.thinking;
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
        className="flex h-8 min-w-0 max-w-full cursor-default items-center gap-1 rounded-md px-1.5 text-xs text-text-secondary transition-colors hover:bg-background-secondary hover:text-text-primary disabled:opacity-60"
      >
        {triggerContent}
        <DropdownChevron open={modelMenuOpen} className="size-3" />
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
          modelMenuOpen={modelMenuOpen}
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
                if (deferUntilSubmit) stageThinkingEffort(provider, model, value);
                else await acpSaveThinkingEffort(value, provider, model);
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
