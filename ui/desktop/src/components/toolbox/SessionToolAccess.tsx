import { useEffect, useRef, useState } from 'react';
import type { ExtensionConfig } from '../../types/extensions';
import { addSessionExtension } from '../../acp/session-extensions';
import { listTools } from '../../acp/permissions';
import { AppEvents } from '../../constants/events';
import { defineMessages, useIntl } from '../../i18n';
import { Button } from '../ui/button';

const messages = defineMessages({
  scope: {
    id: 'toolbox.session.scope',
    defaultMessage: 'Current conversation',
  },
  disabled: {
    id: 'toolbox.session.disabled',
    defaultMessage: 'Enable this tool first',
  },
  loading: {
    id: 'toolbox.session.loading',
    defaultMessage: 'Loading into this conversation…',
  },
  failed: {
    id: 'toolbox.session.failed',
    defaultMessage: 'Load failed. If a turn is running, stop it first, then retry.',
  },
  unknown: {
    id: 'toolbox.session.unknown',
    defaultMessage: 'Conversation status unavailable; refresh to retry',
  },
  missing: {
    id: 'toolbox.session.missing',
    defaultMessage: 'Not loaded in this conversation',
  },
  ready: {
    id: 'toolbox.session.ready',
    defaultMessage: 'Loaded · {count} tools available',
  },
  empty: {
    id: 'toolbox.session.empty',
    defaultMessage: 'Added · no tools discovered yet',
  },
  selected: {
    id: 'toolbox.session.selected',
    defaultMessage: 'Added to this conversation · connection not checked',
  },
  check: {
    id: 'toolbox.session.check',
    defaultMessage: 'Check connection',
  },
  add: {
    id: 'toolbox.session.add',
    defaultMessage: 'Add to this conversation',
  },
});

// Selection and discovered tools are separate facts. A saved selection alone
// must never claim that a remote server connected successfully.
export function SessionToolAccess({
  sessionId,
  extension,
  selected,
  refresh,
  enabled = true,
  label,
}: {
  sessionId: string;
  extension: ExtensionConfig;
  selected: boolean | undefined;
  refresh: () => Promise<void>;
  enabled?: boolean;
  label?: string;
}) {
  const intl = useIntl();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState<number>();
  const [failed, setFailed] = useState(false);
  const configuration = JSON.stringify(extension);
  useEffect(() => {
    setCount(undefined);
    setFailed(false);
  }, [configuration, enabled]);
  const message = (id: keyof typeof messages, values?: Record<string, string | number>) =>
    intl.formatMessage(messages[id], values);
  const load = async () => {
    if (busyRef.current || !enabled || selected === undefined) return;
    busyRef.current = true;
    setBusy(true);
    setFailed(false);
    setCount(undefined);
    try {
      if (!selected) await addSessionExtension(sessionId, extension);
      await refresh();
      window.dispatchEvent(new Event(AppEvents.SESSION_EXTENSIONS_LOADED));
      const tools = await listTools(sessionId, extension.name);
      setCount(tools.length);
    } catch {
      setFailed(true);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 border-t border-border-secondary px-4 py-2.5 text-xs"
      aria-label={message('scope')}
    >
      <span role="status" className="text-text-secondary">
        {label && <span className="mr-2 font-medium">{label}</span>}
        {!enabled
          ? message('disabled')
          : busy
            ? message('loading')
            : failed
              ? message('failed')
              : selected === undefined
                ? message('unknown')
                : !selected
                  ? message('missing')
                  : count
                    ? message('ready', { count })
                    : count === 0
                      ? message('empty')
                      : message('selected')}
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={!enabled || busy || selected === undefined}
        onClick={() => void load()}
      >
        {selected ? message('check') : message('add')}
      </Button>
    </div>
  );
}
