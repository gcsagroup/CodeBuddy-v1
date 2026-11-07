import { useState } from 'react';
import {
  setToolboxSessionMode,
  retryToolboxSession,
  type ToolboxSessionState,
} from '../../acp/toolboxSession';
import { defineMessages, useIntl } from '../../i18n';
import { Button } from '../ui/button';

const messages = defineMessages({
  follow: { id: 'toolbox.sync.follow', defaultMessage: 'Follow toolbox' },
  custom: { id: 'toolbox.sync.custom', defaultMessage: 'Custom selection' },
  restricted: { id: 'toolbox.sync.restricted', defaultMessage: 'Agent-defined selection' },
  pending: {
    id: 'toolbox.sync.pending',
    defaultMessage: 'Saved · changes apply before the next turn. The current task continues.',
  },
  applied: { id: 'toolbox.sync.applied', defaultMessage: 'Current conversation is synchronized.' },
  defaults: {
    id: 'toolbox.sync.defaults',
    defaultMessage:
      'New conversations follow enabled toolbox capabilities. Existing custom conversations keep their selection.',
  },
  failed: { id: 'toolbox.sync.failed', defaultMessage: 'Connection failed' },
  connecting: { id: 'toolbox.sync.connecting', defaultMessage: 'Connecting in background…' },
  ready: { id: 'toolbox.sync.ready', defaultMessage: 'Connected' },
  retry: { id: 'toolbox.sync.retry', defaultMessage: 'Retry connections' },
});

export function ToolboxSessionScope({
  sessionId,
  state,
  readError,
  onChange,
}: {
  sessionId?: string | null;
  state?: ToolboxSessionState;
  readError?: string;
  onChange: () => Promise<void>;
}) {
  const intl = useIntl();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const change = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await operation();
      await onChange();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mb-4 space-y-2 rounded-lg border border-border-secondary p-3 text-sm">
      {!sessionId && <p>{intl.formatMessage(messages.defaults)}</p>}
      {sessionId && state && (
        <>
          <label className="flex items-center gap-2">
            <span>{intl.formatMessage(messages.follow)}</span>
            <select
              aria-label={intl.formatMessage(messages.follow)}
              value={state.mode}
              disabled={busy || state.mode === 'restricted'}
              onChange={(event) =>
                void change(() =>
                  setToolboxSessionMode(sessionId, event.target.value as 'follow' | 'custom')
                )
              }
            >
              <option value="follow">{intl.formatMessage(messages.follow)}</option>
              <option value="custom">{intl.formatMessage(messages.custom)}</option>
              {state.mode === 'restricted' && (
                <option value="restricted">{intl.formatMessage(messages.restricted)}</option>
              )}
            </select>
          </label>
          <p role="status">
            {intl.formatMessage(state.pending ? messages.pending : messages.applied)}
          </p>
          {!state.pending &&
            state.statuses.map((entry) => (
              <div key={entry.serverName}>
                <span>
                  {entry.serverName} ·{' '}
                  {intl.formatMessage(entry.status === 'ready' ? messages.ready : entry.status === 'connecting' ? messages.connecting : messages.failed)}
                </span>
                {entry.error && (
                  <details>
                    <summary>{intl.formatMessage(messages.failed)}</summary>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">
                      {entry.error}
                    </pre>
                  </details>
                )}
              </div>
            ))}
          <Button
            variant="outline"
            size="sm"
            disabled={busy || state.running}
            onClick={() => void change(() => retryToolboxSession(sessionId))}
          >
            {intl.formatMessage(messages.retry)}
          </Button>
        </>
      )}
      {(error || readError) && <p role="alert">{error || readError}</p>}
    </div>
  );
}
