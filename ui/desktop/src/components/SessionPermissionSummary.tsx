import { useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import {
  Check,
  ChevronDown,
  Hand,
  LoaderCircle,
  MessageCircle,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { defineMessages, useIntl } from '../i18n';
import type { Session } from '../types/session';
import { acpSetSessionMode } from '../acp/sessions';
import { all_goose_modes } from './settings/mode/ModeSelectionItem';
import { parseSessionMode } from '../utils/sessionMode';

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
      'Changes apply at the next tool permission check. Running actions are unchanged; pending requests still need a decision.',
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
    defaultMessage: 'Request approval',
  },
  smartLabel: {
    id: 'sessionPermissions.smartLabel',
    defaultMessage: 'Smart approval',
  },
  currentMode: {
    id: 'sessionPermissions.currentMode',
    defaultMessage: 'Current session mode: {mode}',
  },
  unknown: { id: 'sessionPermissions.unknown', defaultMessage: 'Not synchronized' },
  auto: { id: 'modeSelectionItem.autonomousLabel', defaultMessage: 'Full access' },
  approve: { id: 'modeSelectionItem.manualLabel', defaultMessage: 'Request approval' },
  smart_approve: { id: 'modeSelectionItem.smartLabel', defaultMessage: 'Smart approval' },
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
      'Full access is enabled for this conversation. Tool actions do not require per-action approval; explicit denies, file sandbox limits and unavailable tools still apply.',
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
}: {
  session: Session;
  busy?: boolean;
  onSavingChange?: (saving: boolean) => void;
  inline?: boolean;
}) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const savingRef = useRef(false);
  const labels = {
    auto: i18n.autoLabel,
    approve: i18n.manualLabel,
    smart_approve: i18n.smartLabel,
    chat: i18n.chat,
  };
  const icons = {
    auto: ShieldAlert,
    approve: Hand,
    smart_approve: ShieldCheck,
    chat: MessageCircle,
  };
  const ModeIcon = session.goose_mode ? icons[session.goose_mode] : ShieldCheck;
  const changeMode = async (mode: NonNullable<Session['goose_mode']>) => {
    if (savingRef.current || !session.goose_mode || mode === session.goose_mode) return;
    savingRef.current = true;
    setSaving(true);
    onSavingChange?.(true);
    setError(false);
    try {
      await acpSetSessionMode(session.id, mode);
      setOpen(false);
    } catch {
      setError(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
      onSavingChange?.(false);
    }
  };
  const binding = session.extension_data.workspaceBinding;
  const path = session.working_dir;
  const scope =
    binding === 'project_container'
      ? i18n.projectContainer
      : session.goose_mode === 'auto'
        ? i18n.fullAccess
        : binding === 'unbound'
          ? i18n.unbound
          : binding === 'writable_project' && path
            ? null
            : binding === 'root_container' && path
              ? i18n.container
              : session.session_type !== 'code_pro' && path
                ? i18n.directory
                : i18n.unknownScope;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <div className={inline ? 'min-w-0 shrink' : 'mx-4 mb-2'}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className={`flex min-h-7 items-center gap-1.5 rounded-md px-1 text-xs hover:bg-background-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${session.goose_mode === 'auto' ? 'text-orange-700 dark:text-orange-400' : 'text-text-secondary'}`}
            aria-label={intl.formatMessage(i18n.title)}
          >
            {saving ? (
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <ModeIcon className="size-3.5" aria-hidden="true" />
            )}
            <span className="truncate">
              {intl.formatMessage(
                saving
                  ? i18n.pending
                  : session.goose_mode
                    ? labels[session.goose_mode]
                    : i18n.unknown
              )}
            </span>
            <ChevronDown className="size-3.5" aria-hidden="true" />
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
          <fieldset disabled={saving || !session.goose_mode} aria-busy={saving}>
            <legend className="px-2 pb-1.5 pt-1 text-[9.6px] text-text-secondary">
              {intl.formatMessage(i18n.title)}
            </legend>
            {(['approve', 'smart_approve', 'auto', 'chat'] as const).map((key) => {
              const option = all_goose_modes.find((mode) => mode.key === key)!;
              const Icon = icons[key];
              return (
                <label
                  key={key}
                  className={`relative flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-background-secondary has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring ${saving || !session.goose_mode ? 'cursor-not-allowed opacity-60' : ''} ${session.goose_mode === key ? 'bg-background-secondary' : ''} ${key === 'chat' ? 'mt-1 border-t border-border-secondary' : ''}`}
                >
                  <input
                    type="radio"
                    className="sr-only"
                    name={`session-mode-${session.id}`}
                    value={key}
                    checked={session.goose_mode === key}
                    onChange={(event) => {
                      const mode = parseSessionMode(event.target.value);
                      if (mode) void changeMode(mode);
                    }}
                  />
                  <Icon
                    className={`mt-0.5 size-3.5 shrink-0 ${key === 'auto' ? 'text-orange-700 dark:text-orange-400' : 'text-text-secondary'}`}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block text-[11.2px] leading-4 ${key === 'auto' ? 'text-orange-700 dark:text-orange-400' : ''}`}
                    >
                      {intl.formatMessage(labels[key])}
                    </span>
                    <span className="mt-0.5 block text-[9.6px] leading-[15px] text-text-secondary">
                      {intl.formatMessage(option.descriptionDescriptor)}
                    </span>
                  </span>
                  {session.goose_mode === key && (
                    <Check className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  )}
                </label>
              );
            })}
          </fieldset>
          <p className="px-2 pt-1.5 text-[9.6px] leading-[15px] text-text-secondary">
            {intl.formatMessage(busy ? i18n.busy : i18n.onlySession)}
          </p>
          {scope && (session.goose_mode !== 'auto' || binding === 'project_container') && (
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
