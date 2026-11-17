import { SearchableSelect } from '../../ui/SearchableSelect';
import { useEffect, useId, useMemo, useState } from 'react';
import { acpReadConfig, acpUpsertConfig } from '../../../acp/config';
import type { ProviderDetails } from '../../../types/providers';
import { defineMessages, useIntl } from '../../../i18n';
import { Button } from '../../ui/button';

const key = 'compactionFallbackModel';
const messages = defineMessages({
  title: { id: 'compactionSettings.title', defaultMessage: 'Context compaction' },
  description: {
    id: 'compactionSettings.description',
    defaultMessage:
      'Try the current chat model first, then your optional backup, then Qwen Flash. Repeated models are skipped.',
  },
  model: { id: 'compactionSettings.model', defaultMessage: 'Optional backup model' },
  none: {
    id: 'compactionSettings.none',
    defaultMessage: 'Not specified — use Qwen Flash directly after a failure',
  },
  last: {
    id: 'compactionSettings.last',
    defaultMessage:
      'Qwen Flash is the final backup and uses your configured connection. Compaction must fit the current chat model before you can continue.',
  },
  save: { id: 'compactionSettings.save', defaultMessage: 'Save compaction settings' },
  saved: {
    id: 'compactionSettings.saved',
    defaultMessage: 'Saved. Applies to the next compaction.',
  },
  loading: { id: 'compactionSettings.loading', defaultMessage: 'Loading compaction settings…' },
  loadError: {
    id: 'compactionSettings.loadError',
    defaultMessage: 'Could not load compaction settings. Retry before saving.',
  },
  saveError: {
    id: 'compactionSettings.saveError',
    defaultMessage: 'Could not save. Your selection is kept; try again.',
  },
  retry: { id: 'compactionSettings.retry', defaultMessage: 'Retry' },
  unavailable: {
    id: 'compactionSettings.unavailable',
    defaultMessage:
      'Saved model unavailable. Select another model or leave the optional backup unspecified.',
  },
  legacy: {
    id: 'compactionSettings.legacy',
    defaultMessage: 'Your existing model-specific backups are kept until you save a choice here.',
  },
  empty: {
    id: 'compactionSettings.empty',
    defaultMessage: 'Add a model connection to choose an optional backup.',
  },
});

export default function CompactionSettings({
  providers,
  onDirtyChange,
}: {
  providers: ProviderDetails[];
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const intl = useIntl();
  const fieldId = useId();
  const [choice, setChoice] = useState('');
  const [savedChoice, setSavedChoice] = useState('');
  const [ready, setReady] = useState(false);
  const [legacy, setLegacy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<'saved' | 'load-error' | 'save-error' | null>(null);
  const [attempt, setAttempt] = useState(0);
  const groups = useMemo(
    () =>
      providers
        .filter((p) => p.is_configured && p.category !== 'agent')
        .map((p) => ({
          id: p.name,
          label: p.metadata.display_name || p.name,
          models: p.metadata.known_models.map((model) => ({
            id: model.name,
            value: JSON.stringify([p.name, model.name]),
          })),
        })),
    [providers]
  );
  const available =
    !choice || groups.some((group) => group.models.some((model) => model.value === choice));
  const hasModels = groups.some((group) => group.models.length > 0);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setStatus(null);
    void Promise.all([acpReadConfig(key), acpReadConfig('compactionFallbacks')])
      .then(([raw, old]) => {
        if (cancelled) return;
        const config = raw as { model?: { providerId?: unknown; modelId?: unknown } | null } | null;
        if (
          config !== null &&
          (typeof config !== 'object' ||
            !Object.prototype.hasOwnProperty.call(config, 'model') ||
            (config.model !== null &&
              (typeof config.model?.providerId !== 'string' ||
                typeof config.model.modelId !== 'string')))
        )
          throw Error('Invalid compaction settings');
        const value = config?.model
          ? JSON.stringify([config.model.providerId, config.model.modelId])
          : '';
        setChoice(value);
        setSavedChoice(value);
        setLegacy(raw === null && old !== null);
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setStatus('load-error');
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);
  useEffect(() => {
    onDirtyChange?.(ready && choice !== savedChoice);
  }, [ready, choice, savedChoice, onDirtyChange]);

  const save = async () => {
    if (!ready || !available || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const route = choice ? (JSON.parse(choice) as [string, string]) : null;
      await acpUpsertConfig(key, {
        model: route ? { providerId: route[0], modelId: route[1] } : null,
      });
      setSavedChoice(choice);
      setLegacy(false);
      setStatus('saved');
    } catch {
      setStatus('save-error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="runtime-sheet space-y-4"
      aria-busy={busy || (!ready && status !== 'load-error')}
    >
      <h3 className="runtime-title">{intl.formatMessage(messages.title)}</h3>
      <p className="text-sm text-text-muted">{intl.formatMessage(messages.description)}</p>
      <div className="space-y-1">
        <label htmlFor={fieldId} className="block text-sm text-text-primary">
          {intl.formatMessage(messages.model)}
        </label>
        <SearchableSelect
          id={fieldId}
          value={choice}
          disabled={!ready || busy}
          className="h-10 w-full min-w-0 rounded-md border border-border-primary bg-background-primary px-3 text-sm text-text-primary"
          onValueChange={(nextValue) => {
            setChoice(nextValue);
            setStatus(null);
          }}
        >
          <option value="">{intl.formatMessage(messages.none)}</option>
          {!available && (
            <option value={choice} disabled>
              {JSON.parse(choice)[1]} — {intl.formatMessage(messages.unavailable)}
            </option>
          )}
          {groups.map((group) => (
            <optgroup key={group.id} label={group.label}>
              {group.models.map((model) => (
                <option key={model.id} value={model.value}>
                  {model.id} · {group.label}
                </option>
              ))}
            </optgroup>
          ))}
        </SearchableSelect>
      </div>
      {!available && (
        <p role="alert" className="text-sm text-text-secondary">
          {intl.formatMessage(messages.unavailable)}
        </p>
      )}
      {!hasModels && ready && (
        <p className="text-sm text-text-muted">{intl.formatMessage(messages.empty)}</p>
      )}
      {legacy && (
        <p className="text-sm text-text-secondary">{intl.formatMessage(messages.legacy)}</p>
      )}
      <p className="rounded-lg bg-background-secondary px-3 py-2 text-xs leading-relaxed text-text-secondary">
        {intl.formatMessage(messages.last)}
      </p>
      <div className="runtime-actions">
        <Button disabled={!ready || !available || busy} onClick={() => void save()}>
          {intl.formatMessage(messages.save)}
        </Button>
      </div>
      {!ready && status !== 'load-error' && (
        <p role="status" className="text-sm text-text-muted">
          {intl.formatMessage(messages.loading)}
        </p>
      )}
      {status && (
        <p role={status === 'saved' ? 'status' : 'alert'} className="text-sm text-text-secondary">
          {intl.formatMessage(
            status === 'saved'
              ? messages.saved
              : status === 'load-error'
                ? messages.loadError
                : messages.saveError
          )}
        </p>
      )}
      {status === 'load-error' && (
        <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
          {intl.formatMessage(messages.retry)}
        </Button>
      )}
    </section>
  );
}
