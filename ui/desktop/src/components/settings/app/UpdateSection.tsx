import { useEffect, useState } from 'react';
import { Button } from '../../ui/button';
import { defineMessages, useIntl } from '../../../i18n';
import type { UpdateChannel, UpdateState } from '../../../update/types';

const messages = defineMessages({
  check: { id: 'productUpdate.check', defaultMessage: 'Check for updates' },
  download: { id: 'productUpdate.download', defaultMessage: 'Download update' },
  install: { id: 'productUpdate.install', defaultMessage: 'Restart and update' },
  cancel: { id: 'productUpdate.cancel', defaultMessage: 'Cancel download' },
  channel: { id: 'productUpdate.channel', defaultMessage: 'Update channel' },
  stable: { id: 'productUpdate.stable', defaultMessage: 'Stable releases' },
  preview: { id: 'productUpdate.preview', defaultMessage: 'Preview releases' },
  version: { id: 'productUpdate.version', defaultMessage: 'Current version: {version}' },
  idle: {
    id: 'productUpdate.idle',
    defaultMessage: 'Use your connected GitHub account to check for updates.',
  },
  checking: { id: 'productUpdate.checking', defaultMessage: 'Checking for updates…' },
  available: { id: 'productUpdate.available', defaultMessage: 'Version {version} is available.' },
  downloading: {
    id: 'productUpdate.downloading',
    defaultMessage: 'Downloading and verifying… {percent}%',
  },
  ready: {
    id: 'productUpdate.ready',
    defaultMessage: 'Update downloaded. Keep working, or restart when ready. Restarting will stop running tasks; saved chats, settings and files will be retained.',
  },
  installing: {
    id: 'productUpdate.installing',
    defaultMessage: 'Preparing to update. After confirmation, stopping tasks and saving records may take a moment…',
  },
  current: {
    id: 'productUpdate.current',
    defaultMessage: 'No newer compatible release is available in this channel.',
  },
  failed: {
    id: 'productUpdate.failed',
    defaultMessage: 'Update request failed. Please try again.',
  },
});

export default function UpdateSection() {
  const intl = useIntl();
  const [state, setState] = useState<UpdateState>({
    phase: 'idle',
    channel: 'preview',
    currentVersion: window.electron.getVersion(),
  });
  const [checked, setChecked] = useState(false);
  const [localError, setLocalError] = useState('');
  const busy = ['checking', 'downloading', 'installing'].includes(state.phase);
  useEffect(() => {
    let mounted = true;
    let received = false;
    const unsubscribe = window.electron.onUpdaterEvent((event) => {
      if (event.event !== 'state' || !mounted) return;
      received = true;
      setState(event.data as UpdateState);
    });
    void window.electron
      .getUpdateState()
      .then((value) => {
        if (mounted && !received && value) setState(value);
      })
      .catch(() => {
        if (mounted) setLocalError(intl.formatMessage(messages.failed));
      });
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [intl]);
  const run = async (action: () => Promise<UpdateState>) => {
    setLocalError('');
    try {
      setState(await action());
    } catch {
      setLocalError(intl.formatMessage(messages.failed));
    }
  };
  const check = (channel = state.channel) => {
    setChecked(true);
    void run(() => window.electron.checkForUpdates(channel));
  };
  const message =
    state.phase === 'error'
      ? ''
      : intl.formatMessage(
          state.phase === 'idle'
            ? checked
              ? messages.current
              : messages.idle
            : messages[state.phase],
          { version: state.version, percent: state.percent ?? 0 }
        );
  return (
    <div className="space-y-3 py-4">
      <p>{intl.formatMessage(messages.version, { version: state.currentVersion })}</p>
      <label className="flex items-center gap-3 text-sm">
        {intl.formatMessage(messages.channel)}
        <select
          aria-label={intl.formatMessage(messages.channel)}
          className="rounded border bg-background-primary p-2"
          disabled={busy}
          value={state.channel}
          onChange={(event) => check(event.target.value as UpdateChannel)}
        >
          <option value="stable">{intl.formatMessage(messages.stable)}</option>
          <option value="preview">{intl.formatMessage(messages.preview)}</option>
        </select>
      </label>
      <p role="status" className="text-sm text-text-secondary">
        {message}
      </p>
      {(state.error || localError) && (
        <p role="alert" className="text-sm text-red-600">
          {state.error || localError}
        </p>
      )}
      {state.phase === 'downloading' && (
        <progress className="w-full" max={100} value={state.percent ?? 0} />
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => check()}>
          {intl.formatMessage(messages.check)}
        </Button>
        {(state.phase === 'available' || (state.phase === 'error' && state.version)) && (
          <Button size="sm" onClick={() => void run(() => window.electron.downloadUpdate())}>
            {intl.formatMessage(messages.download)}
          </Button>
        )}
        {state.phase === 'ready' && (
          <Button size="sm" onClick={() => void run(() => window.electron.installUpdate())}>
            {intl.formatMessage(messages.install)}
          </Button>
        )}
        {state.phase === 'downloading' && (
          <Button variant="secondary" size="sm" onClick={() => void window.electron.cancelUpdate()}>
            {intl.formatMessage(messages.cancel)}
          </Button>
        )}
      </div>
      {state.notes && (
        <div className="max-h-64 overflow-auto whitespace-pre-wrap text-sm text-text-secondary">
          {state.notes}
        </div>
      )}
    </div>
  );
}
