import { useState } from 'react';
import { useIntl } from '../../../i18n';
import { followUpMessages } from '../../followUpMessages';
import { useFollowUpMode, type FollowUpMode } from '../../../hooks/useFollowUpMode';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card';

export function FollowUpSettings() {
  const intl = useIntl();
  const preference = useFollowUpMode();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const mode = preference.mode;

  async function save(next: FollowUpMode) {
    if (saving || next === mode) return;
    setSaving(true);
    setError(false);
    try {
      // The main process saves first and broadcasts the authoritative value.
      await window.electron.setSetting('followUpMode', next);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="border-border-primary shadow-none">
      <CardHeader>
        <CardTitle>{intl.formatMessage(followUpMessages.title)}</CardTitle>
        <CardDescription>{intl.formatMessage(followUpMessages.description)}</CardDescription>
      </CardHeader>
      <CardContent>
        <div
          className="inline-flex gap-1 rounded-lg bg-background-secondary p-1"
          role="group"
          aria-label={intl.formatMessage(followUpMessages.title)}
        >
          {(['queue', 'steer'] as const).map(value => (
            <button
              key={value}
              type="button"
              aria-pressed={preference.ready && mode === value}
              disabled={saving || !preference.ready}
              className={`rounded-md px-4 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${mode === value ? 'bg-background-primary text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'}`}
              onClick={() => void save(value)}
            >
              {intl.formatMessage(followUpMessages[value])}
            </button>
          ))}
        </div>
        {preference.error && (
          <p role="alert" className="mt-2 text-sm text-red-500">
            {intl.formatMessage(followUpMessages.loadFailed)}{' '}
            <button type="button" className="underline" onClick={preference.reload}>
              {intl.formatMessage(followUpMessages.retry)}
            </button>
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-sm text-red-500">
            {intl.formatMessage(followUpMessages.failed)}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
