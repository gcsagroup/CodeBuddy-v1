import { useEffect, useId, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
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

export function ThinkingEffortPicker({
  settings,
  onChange,
  disabled = false,
  error = false,
  showLabel = false,
  openOnHover = false,
  popupSide = 'top',
}: {
  settings: ModelThinkingSettings;
  onChange: (value: ThinkingEffort) => Promise<void> | void;
  disabled?: boolean;
  error?: boolean;
  showLabel?: boolean;
  openOnHover?: boolean;
  popupSide?: 'top' | 'left';
}) {
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
