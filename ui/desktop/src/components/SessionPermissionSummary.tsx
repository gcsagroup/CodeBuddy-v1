import { useEffect, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, LoaderCircle, Shield, ShieldAlert, ShieldCheck } from 'lucide-react';
import { defineMessages, useIntl } from '../i18n';
import type { Session } from '../types/session';
import { acpSetSessionMode } from '../acp/sessions';
import { all_goose_modes } from './settings/mode/ModeSelectionItem';
import { parseSessionMode } from '../utils/sessionMode';
import { readPreferences } from '../acp/preferences';
import { DropdownChevron } from './ui/DropdownChevron';

const i18n = defineMessages({
  projectContainer: {
    id: 'sessionPermissions.projectContainer',
    defaultMessage: 'Project parent: {path}. The parent is not authorized for project writes.',
  },
  title: {
    id: 'sessionPermissions.pickerTitle',
    defaultMessage: 'How should actions be approved?',
  },
  pending: { id: 'sessionPermissions.saving', defaultMessage: 'Changing permissions…' },
  busy: {
    id: 'sessionPermissions.busy',
    defaultMessage:
      'Changes apply to this Agent. Running actions are unchanged; existing subagents keep their delegated permissions.',
  },
  error: {
    id: 'sessionPermissions.saveError',
    defaultMessage: 'Could not confirm the change. Please try again.',
  },
  onlySession: {
    id: 'sessionPermissions.onlySession',
    defaultMessage:
      'Applies to this conversation only. Existing tool permission rules still apply.',
  },
  autoLabel: { id: 'sessionPermissions.autoLabel', defaultMessage: 'Full access' },
  manualLabel: {
    id: 'sessionPermissions.manualLabel',
    defaultMessage: 'Read only',
  },
  smartLabel: {
    id: 'sessionPermissions.smartLabel',
    defaultMessage: 'Workspace write',
  },
  currentMode: {
    id: 'sessionPermissions.currentMode',
    defaultMessage: 'Current session mode: {mode}',
  },
  unknown: { id: 'sessionPermissions.unknown', defaultMessage: 'Not synchronized' },
  auto: { id: 'modeSelectionItem.autonomousLabel', defaultMessage: 'Full access' },
  approve: { id: 'modeSelectionItem.manualLabel', defaultMessage: 'Read only' },
  smart_approve: { id: 'modeSelectionItem.smartLabel', defaultMessage: 'Workspace write' },
  chat: { id: 'modeSelectionItem.chatOnlyLabel', defaultMessage: 'Chat only' },
  container: {
    id: 'sessionPermissions.container',
    defaultMessage: 'Root folder: {path}. Select a project before writing files.',
  },
  unbound: {
    id: 'sessionPermissions.unbound',
    defaultMessage: 'No project is authorized for writing.',
  },
  directory: {
    id: 'sessionPermissions.directory',
    defaultMessage: 'Working directory: {path}. This does not grant permission for every action.',
  },
  fullAccess: {
    id: 'sessionPermissions.fullAccess',
    defaultMessage:
      'The file and command sandbox is disabled for this Agent. Explicit tool restrictions still apply.',
  },
  unknownScope: {
    id: 'sessionPermissions.unknownScope',
    defaultMessage: 'Workspace permissions have not been synchronized.',
  },
});

export function SessionPermissionSummary({
  session,
  busy = false,
  onSavingChange,
  inline = false,
  openRequest = 0,
}: {
  openRequest?: number;
  session: Session;
  busy?: boolean;
  onSavingChange?: (saving: boolean) => void;
  inline?: boolean;
}) {
  return (
    <PermissionPicker
      openRequest={openRequest}
      mode={session.goose_mode}
      id={session.id}
      workingDirectory={session.working_dir}
      onModeChange={(mode) => acpSetSessionMode(session.id, mode)}
      busy={busy}
      inline={inline}
      onSavingChange={onSavingChange}
    />
  );
}

type PermissionPreset = NonNullable<Session['goose_mode']>;

// Before a session exists this is only a user draft. It becomes execution
// authority after session/new returns the preset committed by DSH.
export function useInitialPermissionPreset() {
  const [preset, setPreset] = useState<PermissionPreset>();
  const selected = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void readPreferences(['gooseMode'])
      .then((snapshot) => {
        if (cancelled || selected.current) return;
        const value = snapshot.values.find((entry) => entry.key === 'gooseMode')?.value;
        setPreset(value == null ? 'workspace-write' : parseSessionMode(value));
      })
      .catch(() => {
        /* Keep unknown; the user may still choose explicitly. */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return [
    preset,
    (value: PermissionPreset) => {
      selected.current = true;
      setPreset(value);
    },
  ] as const;
}

export function PermissionPicker({
  mode,
  id = 'new-session',
  workingDirectory,
  onModeChange,
  busy = false,
  inline = false,
  onSavingChange,
  draft = false,
  openRequest = 0,
}: {
  openRequest?: number;
  mode?: PermissionPreset;
  id?: string;
  workingDirectory?: string;
  onModeChange: (mode: PermissionPreset) => void | Promise<void>;
  busy?: boolean;
  inline?: boolean;
  onSavingChange?: (saving: boolean) => void;
  draft?: boolean;
}) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  useEffect(() => { if (openRequest > 0) setOpen(true); }, [openRequest]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const savingRef = useRef(false);
  const labels = {
    'danger-full-access': i18n.autoLabel,
    'read-only': i18n.manualLabel,
    'workspace-write': i18n.smartLabel,
  };
  const icons = {
    'danger-full-access': ShieldAlert,
    'read-only': Shield,
    'workspace-write': ShieldCheck,
  };
  const ModeIcon = mode ? icons[mode] : ShieldCheck;
  const changeMode = async (nextMode: PermissionPreset) => {
    if (savingRef.current || (!draft && !mode) || nextMode === mode) return;
    savingRef.current = true;
    setSaving(true);
    onSavingChange?.(true);
    setError(false);
    try {
      await onModeChange(nextMode);
      setOpen(false);
    } catch {
      setError(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
      onSavingChange?.(false);
    }
  };
  const path = workingDirectory;
  const scope = !mode
    ? i18n.unknownScope
    : mode === 'danger-full-access'
      ? i18n.fullAccess
      : path
        ? i18n.directory
        : i18n.unknownScope;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <div className={inline ? 'min-w-0 shrink' : 'mx-4 mb-2'}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className={`flex min-h-7 items-center gap-1.5 rounded-md px-1 text-xs hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${mode === 'danger-full-access' ? 'text-orange-700 dark:text-orange-400' : 'text-text-secondary'}`}
            aria-label={intl.formatMessage(i18n.title)}
          >
            {saving ? (
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <ModeIcon className="size-3.5" aria-hidden="true" />
            )}
            <span className="truncate group-data-[compact=true]/composer-toolbar:hidden">
              {intl.formatMessage(saving ? i18n.pending : mode ? labels[mode] : i18n.unknown)}
            </span>
            <DropdownChevron
              open={open}
              className="size-3.5 group-data-[compact=true]/composer-toolbar:hidden"
            />
          </button>
        </Popover.Trigger>
        {!open && error && (
          <p role="alert" className="mt-1 text-xs text-text-danger">
            {intl.formatMessage(i18n.error)}
          </p>
        )}
      </div>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="z-[100] w-[min(18rem,calc(100vw-2rem))] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-xl border border-border-primary bg-background-primary p-1.5 text-text-primary shadow-md"
        >
          <fieldset disabled={saving || (!draft && !mode)} aria-busy={saving}>
            <legend className="px-2 pb-1.5 pt-1 text-[9.6px] text-text-secondary">
              {intl.formatMessage(i18n.title)}
            </legend>
            {(['read-only', 'workspace-write', 'danger-full-access'] as const).map((key) => {
              const option = all_goose_modes.find((mode) => mode.key === key)!;
              const Icon = icons[key];
              return (
                <label
                  key={key}
                  className={`relative flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-background-secondary has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring ${saving || (!draft && !mode) ? 'cursor-not-allowed opacity-60' : ''} ${mode === key ? 'bg-background-secondary' : ''}`}
                >
                  <input
                    type="radio"
                    className="sr-only"
                    name={`session-mode-${id}`}
                    value={key}
                    checked={mode === key}
                    onChange={(event) => {
                      const mode = parseSessionMode(event.target.value);
                      if (mode) void changeMode(mode);
                    }}
                  />
                  <Icon
                    className={`mt-0.5 size-3.5 shrink-0 ${key === 'danger-full-access' ? 'text-orange-700 dark:text-orange-400' : 'text-text-secondary'}`}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block text-[11.2px] leading-4 ${key === 'danger-full-access' ? 'text-orange-700 dark:text-orange-400' : ''}`}
                    >
                      {intl.formatMessage(labels[key])}
                    </span>
                    <span className="mt-0.5 block text-[9.6px] leading-[15px] text-text-secondary">
                      {intl.formatMessage(option.descriptionDescriptor)}
                    </span>
                  </span>
                  {mode === key && (
                    <Check className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  )}
                </label>
              );
            })}
          </fieldset>
          <p className="px-2 pt-1.5 text-[9.6px] leading-[15px] text-text-secondary">
            {intl.formatMessage(busy ? i18n.busy : i18n.onlySession)}
          </p>
          {scope && (
            <p className="px-2 pt-1 text-[9.6px] leading-[15px] break-words text-text-secondary">
              {intl.formatMessage(scope, { path })}
            </p>
          )}
          {error && (
            <p role="alert" className="px-2 pt-2 text-[9.6px] text-text-danger">
              {intl.formatMessage(i18n.error)}
            </p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
