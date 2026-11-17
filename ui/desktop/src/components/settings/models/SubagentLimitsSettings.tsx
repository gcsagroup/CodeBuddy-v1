import { useEffect, useId, useState } from 'react';
import { acpReadConfig, acpUpsertConfig } from '../../../acp/config';
import { defineMessages, useIntl } from '../../../i18n';
import { Button } from '../../ui/button';

const messages = defineMessages({
  title: { id: 'subagentLimits.title', defaultMessage: 'Runtime limits' },
  depth: { id: 'subagentLimits.depth', defaultMessage: 'Maximum recursion depth' },
  parallel: { id: 'subagentLimits.parallel', defaultMessage: 'Maximum parallel subagents' },
  hint: {
    id: 'subagentLimits.hint',
    defaultMessage:
      'Depth 0 prevents delegation; 1 allows direct children. The parallel limit counts active descendants of one main agent. Changes apply when the next task is prepared; existing children are not cancelled.',
  },
  save: { id: 'subagentLimits.save', defaultMessage: 'Save limits' },
  saved: {
    id: 'subagentLimits.saved',
    defaultMessage: 'Saved. Applies when the next task is prepared.',
  },
  error: {
    id: 'subagentLimits.error',
    defaultMessage: 'Could not load or save limits. Your saved configuration was not changed.',
  },
  retry: { id: 'subagentTemplates.retry', defaultMessage: 'Retry' },
});
type Limits = { maxDepth: number; maxActiveSubagents: number };
const valid = (value: Limits | null): value is Limits =>
  Boolean(
    value &&
    Number.isSafeInteger(value.maxDepth) &&
    value.maxDepth >= 0 &&
    Number.isSafeInteger(value.maxActiveSubagents) &&
    value.maxActiveSubagents >= 1
  );

export default function SubagentLimitsSettings({
  onDirtyChange,
}: {
  onDirtyChange: (dirty: boolean) => void;
}) {
  const intl = useIntl();
  const id = useId();
  const [saved, setSaved] = useState<Limits | null>(null);
  const [depth, setDepth] = useState('');
  const [parallel, setParallel] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'saved' | 'error' | null>(null);
  const dirty = Boolean(
    saved && (depth !== String(saved.maxDepth) || parallel !== String(saved.maxActiveSubagents))
  );
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    let current = true;
    setStatus(null);
    void acpReadConfig('subagentLimits', false)
      .then((value) => {
        if (!valid(value as Limits)) throw new Error('Invalid limits');
        if (!current) return;
        const limits = value as Limits;
        setSaved(limits);
        setDepth(String(limits.maxDepth));
        setParallel(String(limits.maxActiveSubagents));
      })
      .catch(() => {
        if (current) setStatus('error');
      });
    return () => {
      current = false;
    };
  }, [attempt]);
  const next =
    depth.trim() && parallel.trim()
      ? { maxDepth: Number(depth), maxActiveSubagents: Number(parallel) }
      : null;
  return (
    <section className="subagent-limits space-y-3" aria-label={intl.formatMessage(messages.title)}>
      <h3 className="text-sm font-medium">{intl.formatMessage(messages.title)}</h3>
      <fieldset disabled={!saved || saving} className="grid gap-3 sm:grid-cols-2">
        {(
          [
            ['depth', messages.depth, depth, setDepth, 0],
            ['parallel', messages.parallel, parallel, setParallel, 1],
          ] as const
        ).map(([field, label, value, setValue, min]) => (
          <label key={field} htmlFor={`${id}-${field}`} className="space-y-1 text-sm">
            <span className="block">{intl.formatMessage(label)}</span>
            <input
              id={`${id}-${field}`}
              type="number"
              min={min}
              max={Number.MAX_SAFE_INTEGER}
              step={1}
              value={value}
              className="h-10 w-full rounded-md border border-border-primary bg-background-primary px-3 text-text-primary"
              onChange={(event) => {
                setValue(event.target.value);
                setStatus(null);
              }}
            />
          </label>
        ))}
      </fieldset>
      <p className="text-xs text-text-secondary">{intl.formatMessage(messages.hint)}</p>
      <Button
        size="sm"
        variant="outline"
        disabled={!saved || saving || !dirty || !valid(next)}
        onClick={async () => {
          if (!valid(next) || saving) return;
          setSaving(true);
          setStatus(null);
          try {
            await acpUpsertConfig('subagentLimits', next);
            setSaved(next);
            setStatus('saved');
          } catch {
            setStatus('error');
          } finally {
            setSaving(false);
          }
        }}
      >
        {intl.formatMessage(messages.save)}
      </Button>
      {status && (
        <p role={status === 'error' ? 'alert' : 'status'} className="text-sm text-text-secondary">
          {intl.formatMessage(messages[status])}
        </p>
      )}
      {status === 'error' && !saved && (
        <Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
          {intl.formatMessage(messages.retry)}
        </Button>
      )}
    </section>
  );
}
