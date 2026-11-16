import { useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { acpExportSessionLog, type DiagnosticDetail } from '../acp/sessions';
import { defineMessages, useIntl } from '../i18n';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

const messages = defineMessages({
  title: { id: 'diagnosticExport.title', defaultMessage: 'Export logs' },
  standard: { id: 'diagnosticExport.standard', defaultMessage: 'Standard logs' },
  standardHint: {
    id: 'diagnosticExport.standardHint',
    defaultMessage:
      'Model routes, budgets, call order and errors. Conversation and reasoning text are excluded.',
  },
  detailed: { id: 'diagnosticExport.detailed', defaultMessage: 'Detailed logs' },
  detailedHint: {
    id: 'diagnosticExport.detailedHint',
    defaultMessage:
      'Adds tool-output excerpts. Check the contents in the preview before saving.',
  },
  preview: { id: 'diagnosticExport.preview', defaultMessage: 'File preview' },
  loading: { id: 'diagnosticExport.loading', defaultMessage: 'Preparing logs…' },
  failed: {
    id: 'diagnosticExport.failed',
    defaultMessage: 'Logs could not be prepared or saved. Please retry.',
  },
  save: { id: 'diagnosticExport.save', defaultMessage: 'Save this preview' },
  retry: { id: 'diagnosticExport.retry', defaultMessage: 'Try again' },
  cancel: { id: 'diagnosticExport.cancel', defaultMessage: 'Cancel' },
  saved: { id: 'diagnosticExport.saved', defaultMessage: 'Logs saved' },
  notice: {
    id: 'diagnosticExport.notice',
    defaultMessage: 'Save the log shown in the preview. The original local log is unchanged.',
  },
});

export function DiagnosticExportDialog({
  sessionId,
  open,
  onOpenChange,
}: {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const intl = useIntl();
  const [detail, setDetail] = useState<DiagnosticDetail>('standard');
  const [snapshot, setSnapshot] = useState<{
    sessionId: string;
    detail: DiagnosticDetail;
    text: string;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const savingRef = useRef(false);
  useEffect(() => {
    const request = ++generation.current;
    setSnapshot(null);
    setFailed(false);
    if (!open) {
      setDetail('standard');
      return;
    }
    void acpExportSessionLog(sessionId, detail)
      .then((text) => {
        if (generation.current === request) setSnapshot({ sessionId, detail, text });
      })
      .catch(() => {
        if (generation.current === request) setFailed(true);
      });
    // Ignore late reads after close, mode changes or switching conversations.
    // https://react.dev/reference/react/useEffect#fetching-data-with-effects
    return () => {
      generation.current = request + 1;
    };
  }, [sessionId, detail, open, reload]);
  const ready = open && snapshot?.sessionId === sessionId && snapshot.detail === detail;
  const close = (value: boolean) => {
    if (!value) {
      generation.current++;
      setSnapshot(null);
      setDetail('standard');
    }
    onOpenChange(value);
  };
  const save = async () => {
    if (!ready || !snapshot || savingRef.current) return;
    const request = generation.current,
      text = snapshot.text;
    savingRef.current = true;
    setSaving(true);
    try {
      const destination = await window.electron.showSaveDialog({
        title: intl.formatMessage(messages.title),
        defaultDirectory: 'desktop',
        defaultPath: detail === 'detailed' ? 'session-log-detailed.jsonl' : 'session-log.jsonl',
        filters: [{ name: 'JSONL', extensions: ['jsonl'] }],
      });
      if (generation.current !== request || destination.canceled || !destination.filePath) return;
      if (!(await window.electron.writeFile(destination.filePath, text)))
        throw new Error('Diagnostic write failed');
      if (generation.current !== request) return;
      toast.success(intl.formatMessage(messages.saved));
      close(false);
    } catch {
      if (generation.current === request) toast.error(intl.formatMessage(messages.failed));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="grid h-[85vh] max-h-[48rem] grid-rows-[auto_auto_minmax(6rem,1fr)_auto] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage(messages.title)}</DialogTitle>
          <DialogDescription>{intl.formatMessage(messages.notice)}</DialogDescription>
        </DialogHeader>
        <fieldset className="space-y-3" disabled={saving}>
          <legend className="sr-only">{intl.formatMessage(messages.title)}</legend>
          {(['standard', 'detailed'] as const).map((mode) => (
            <label key={mode} className="flex items-start gap-3 text-sm text-text-primary">
              <input
                type="radio"
                name="diagnostic-detail"
                value={mode}
                checked={detail === mode}
                className="mt-1 accent-current"
                onChange={() => {
                  setDetail(mode);
                }}
              />
              <span>
                <span className="font-medium">{intl.formatMessage(messages[mode])}</span>
                <span className="mt-1 block text-text-secondary">
                  {intl.formatMessage(
                    messages[mode === 'standard' ? 'standardHint' : 'detailedHint']
                  )}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="min-h-0 min-w-0">
          {failed ? (
            <div role="alert" className="space-y-3 text-sm text-text-primary">
              <p>{intl.formatMessage(messages.failed)}</p>
              <Button variant="outline" onClick={() => setReload((value) => value + 1)}>
                {intl.formatMessage(messages.retry)}
              </Button>
            </div>
          ) : ready ? (
            <textarea
              readOnly
              aria-label={intl.formatMessage(messages.preview)}
              value={snapshot?.text ?? ''}
              className="h-full w-full resize-none rounded-lg border border-border-primary bg-background-secondary p-3 font-mono text-sm text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-active"
            />
          ) : (
            <p role="status" className="py-6 text-sm text-text-secondary">
              {intl.formatMessage(messages.loading)}
            </p>
          )}
        </div>
        <div className="space-y-4">
          <DialogFooter>
            <Button variant="outline" onClick={() => close(false)}>
              {intl.formatMessage(messages.cancel)}
            </Button>
            <Button disabled={!ready || saving} onClick={() => void save()}>
              {intl.formatMessage(messages.save)}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
