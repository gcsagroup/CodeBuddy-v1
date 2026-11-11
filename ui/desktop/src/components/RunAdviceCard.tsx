import { useId, useState } from 'react';
import { ChevronDown, Info } from 'lucide-react';
import { defineMessages, useIntl } from '../i18n';
import type { RunAdvice } from './codepro/useWorkStatus';

const labels = defineMessages({
  waiting: {
    id: 'runAdvice.waiting',
    defaultMessage: 'Waiting for a response',
  },
  waitingBody: {
    id: 'runAdvice.waitingBody',
    defaultMessage: 'No content received for {seconds}s. The service may be busy.',
  },
  generation: {
    id: 'runAdvice.generation',
    defaultMessage: 'Still generating',
  },
  generationBody: {
    id: 'runAdvice.generationBody',
    defaultMessage: 'Generating for {seconds}s. You can wait or try another model.',
  },
  tools: { id: 'runAdvice.tools', defaultMessage: 'Tool attempts failed' },
  toolsBody: {
    id: 'runAdvice.toolsBody',
    defaultMessage:
      '{count} recent attempts failed. Check tool results for permission or environment issues.',
  },
  responses: {
    id: 'runAdvice.responses',
    defaultMessage: 'Response retried several times',
  },
  responsesBody: {
    id: 'runAdvice.responsesBody',
    defaultMessage:
      '{count} retries without a successful tool result. You can wait or try another model.',
  },
  wait: { id: 'runAdvice.wait', defaultMessage: 'Keep waiting' },
  stop: { id: 'runAdvice.stop', defaultMessage: 'Stop and choose a model' },
  stopping: { id: 'runAdvice.stopping', defaultMessage: 'Stopping…' },
  details: { id: 'runAdvice.details', defaultMessage: 'Details' },
  footnote: {
    id: 'runAdvice.footnote',
    defaultMessage:
      'Existing files are kept. After switching models, send the task again when ready.',
  },
});

export function RunAdviceCard({
  advice,
  attemptId,
  stopping,
  onStopAndChoose,
  statusMessage,
}: {
  advice?: RunAdvice;
  attemptId: string;
  stopping: boolean;
  onStopAndChoose: () => void;
  statusMessage?: string;
}) {
  const intl = useIntl();
  const [dismissed, setDismissed] = useState<string>();
  const [expandedAttempt, setExpandedAttempt] = useState<string>();
  const detailsId = useId();
  const expanded = expandedAttempt === attemptId;
  if (!advice) return null;
  if (dismissed === attemptId)
    return statusMessage ? (
      <p
        role="status"
        title={statusMessage}
        className="mx-4 mb-2 truncate text-xs text-text-secondary"
      >
        {statusMessage}
      </p>
    ) : null;
  const body = {
    waiting: labels.waitingBody,
    generation: labels.generationBody,
    tools: labels.toolsBody,
    responses: labels.responsesBody,
  }[advice.kind];
  return (
    <aside
      aria-label={intl.formatMessage(labels[advice.kind])}
      className="mx-4 mb-2 rounded-xl border border-border-primary bg-background-secondary/50 px-3.5 py-3 text-sm"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-text-secondary" />
        <div className="min-w-0 flex-1">
          <p role="status" className="font-medium text-text-primary">
            {intl.formatMessage(labels[advice.kind])}
          </p>
          <p className="mt-0.5 break-words text-xs leading-5 text-text-secondary">
            {intl.formatMessage(body, {
              seconds: 'seconds' in advice ? advice.seconds : 0,
              count: 'count' in advice ? advice.count : 0,
            })}
          </p>
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpandedAttempt(expanded ? undefined : attemptId)}
          className="mr-auto flex items-center gap-1 rounded py-1 text-xs text-text-secondary hover:text-text-primary focus-visible:outline focus-visible:outline-2"
        >
          {intl.formatMessage(labels.details)}
          <ChevronDown
            aria-hidden="true"
            className={`size-3 transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
        </button>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
          <button
            type="button"
            disabled={stopping}
            onClick={() => setDismissed(attemptId)}
            className="rounded-lg px-3 py-1.5 text-xs text-text-secondary hover:bg-background-primary disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {intl.formatMessage(labels.wait)}
          </button>
          <button
            type="button"
            disabled={stopping}
            onClick={onStopAndChoose}
            className="rounded-lg border border-border-primary bg-background-primary px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-background-secondary disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {intl.formatMessage(stopping ? labels.stopping : labels.stop)}
          </button>
        </div>
      </div>
      <div
        id={detailsId}
        hidden={!expanded}
        className="mt-2 space-y-1 border-t border-border-primary pt-2 text-xs leading-5 text-text-secondary [overflow-wrap:anywhere]"
      >
        {statusMessage && <p>{statusMessage}</p>}
        <p>{intl.formatMessage(labels.footnote)}</p>
      </div>
    </aside>
  );
}
