import { useState } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import { defineMessages, useIntl } from '../../../i18n';
import { useTypography } from '../../../contexts/TypographyContext';
import type { Settings } from '../../../utils/settings';
import {
  codeSizeRange,
  defaultTypography,
  zoomRange,
  textSizeRange,
  type Typography,
} from '../../../utils/typography';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';

const messages = defineMessages({
  title: { id: 'typography.title', defaultMessage: 'Typography' },
  zoom: { id: 'typography.zoom', defaultMessage: 'Window zoom' },
  zoomHint: {
    id: 'typography.zoomHint',
    defaultMessage: 'Scale chat, the sidebar, and controls together.',
  },
  text: { id: 'typography.text', defaultMessage: 'Interface text size' },
  textHint: { id: 'typography.textHint', defaultMessage: 'Change chat text, the message box and interface labels.' },
  sample: { id: 'typography.sample', defaultMessage: 'Your messages will look like this.' },
  size: { id: 'typography.size', defaultMessage: 'Code font size' },
  sizeHint: {
    id: 'typography.sizeHint',
    defaultMessage: 'Applies to code blocks, the file editor, and diffs.',
  },
  font: { id: 'typography.font', defaultMessage: 'Interface font' },
  default: { id: 'typography.default', defaultMessage: 'CodeBuddy default' },
  system: { id: 'typography.system', defaultMessage: 'System font' },
  serif: { id: 'typography.serif', defaultMessage: 'Serif' },
  less: { id: 'typography.less', defaultMessage: 'Decrease {setting}' },
  more: { id: 'typography.more', defaultMessage: 'Increase {setting}' },
  reset: { id: 'typography.reset', defaultMessage: 'Reset {setting}' },
  failed: { id: 'typography.failed', defaultMessage: 'Could not save your display preference.' },
});

export function TypographySettings() {
  const intl = useIntl();
  const preferences = useTypography();
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  async function save<K extends keyof Typography>(key: K, value: Settings[K]) {
    setSaving(true);
    setError(false);
    try {
      await window.electron.setSetting(key, value);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  }

  const iconButton =
    'inline-flex size-8 items-center justify-center rounded-md text-text-secondary hover:bg-background-tertiary focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30';
  return (
    <Card className="rounded-lg">
      <CardHeader>
        <CardTitle>{intl.formatMessage(messages.title)}</CardTitle>
      </CardHeader>
      <CardContent className="divide-y divide-border-primary px-4">
        {(['textSize', 'codeFontSize', 'windowZoom'] as const).map((key) => {
          const zoom = key === 'windowZoom';
          const { min, max, step } = zoom ? zoomRange : key === 'textSize' ? textSizeRange : codeSizeRange;
          const value = preferences[key];
          const setting = intl.formatMessage(zoom ? messages.zoom : key === 'textSize' ? messages.text : messages.size);
          return (
            <div
              key={key}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 first:pt-0"
            >
              <div className="min-w-32 flex-1">
                <h3 className="text-sm font-medium">{setting}</h3>
                <p className="text-xs text-text-secondary">
                  {intl.formatMessage(zoom ? messages.zoomHint : key === 'textSize' ? messages.textHint : messages.sizeHint)}
                </p>
                {key === 'textSize' && <p className="mt-2 text-sm leading-normal">{intl.formatMessage(messages.sample)}</p>}
                {key === 'codeFontSize' && <code className="mt-2 block leading-normal" style={{ fontSize: 'var(--code-font-size)' }}>const ready = true;</code>}
              </div>
              <div className="flex items-center gap-1" role="group" aria-label={setting}>
                {value !== defaultTypography[key] && (
                  <button
                    type="button"
                    className={iconButton}
                    disabled={saving}
                    aria-label={intl.formatMessage(messages.reset, { setting })}
                    onClick={() => void save(key, defaultTypography[key])}
                  >
                    <RotateCcw size={15} />
                  </button>
                )}
                <div className="flex items-center rounded-lg border border-border-primary">
                  <button
                    type="button"
                    className={iconButton}
                    disabled={saving || value <= min}
                    aria-label={intl.formatMessage(messages.less, { setting })}
                    onClick={() => void save(key, value - step)}
                  >
                    <Minus size={15} />
                  </button>
                  <output className="min-w-12 text-center text-sm tabular-nums">
                    {value}
                    {zoom ? '%' : ' px'}
                  </output>
                  <button
                    type="button"
                    className={iconButton}
                    disabled={saving || value >= max}
                    aria-label={intl.formatMessage(messages.more, { setting })}
                    onClick={() => void save(key, value + step)}
                  >
                    <Plus size={15} />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        <label className="flex flex-wrap items-center justify-between gap-3 pt-3 text-sm font-medium">
          {intl.formatMessage(messages.font)}
          <select
            className="max-w-full rounded-lg border border-border-primary bg-background-primary px-2 py-1.5 text-sm font-normal"
            value={preferences.uiFont}
            disabled={saving}
            onChange={(event) => void save('uiFont', event.target.value as Typography['uiFont'])}
          >
            {(['default', 'system', 'serif'] as const).map((font) => (
              <option key={font} value={font}>
                {intl.formatMessage(messages[font])}
              </option>
            ))}
          </select>
        </label>
        {error && (
          <p role="alert" className="mt-2 text-sm">
            {intl.formatMessage(messages.failed)}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
