import { useEffect, useRef, useState } from 'react';
import { FileText, X } from 'lucide-react';
import { defineMessages, useIntl } from '../i18n';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/Tooltip';

const messages = defineMessages({
  text: { id: 'pastedText.text', defaultMessage: 'Pasted text · {count} characters' },
  preview: {
    id: 'pastedText.previewHint',
    defaultMessage: 'Preview of first {count} characters · Click the text block to open a TXT copy',
  },
  open: { id: 'pastedText.open', defaultMessage: 'Open pasted text as TXT' },
  remove: { id: 'pastedText.remove', defaultMessage: 'Remove pasted text' },
  failed: {
    id: 'pastedText.openFailed',
    defaultMessage: 'Could not open the text copy. Please try again.',
  },
});
const PREVIEW_LIMIT = 12000;

export function PastedTextPreview({ text, onRemove }: { text: string; onRemove?: () => void }) {
  const intl = useIntl();
  const opening = useRef(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preview = (open: boolean, delay = 0) => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => setPreviewOpen(open), delay);
  };
  useEffect(
    () => () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
    },
    []
  );
  const [failed, setFailed] = useState(false);
  const openText = async () => {
    preview(false);
    if (opening.current) return;
    opening.current = true;
    setFailed(false);
    try {
      const result = await window.electron.openPastedText(text);
      if (!result?.opened) setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      opening.current = false;
    }
  };
  return (
    <div className="relative w-72 min-w-0 max-w-full text-text-primary" data-pasted-text>
      <div className="flex min-w-0 items-center gap-2 rounded-xl bg-background-secondary px-3 py-2 text-sm">
        <FileText size={18} className="shrink-0 text-text-secondary" aria-hidden />
        <Tooltip
          open={previewOpen}
          onOpenChange={(open) => {
            if (!open) preview(false);
          }}
        >
          <TooltipTrigger asChild>
            <button
              type="button"
              className="min-w-0 flex-1 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-primary"
              aria-label={intl.formatMessage(messages.open)}
              onMouseEnter={() => preview(true, 180)}
              onMouseLeave={() => preview(false, 120)}
              onFocus={() => preview(true)}
              onBlur={() => preview(false, 120)}
              onClick={() => void openText()}
            >
              <span className="block truncate">
                {text.slice(0, 80).replace(/\s+/g, ' ').trim()}
              </span>
              <span className="block truncate text-xs text-text-secondary">
                {intl.formatMessage(messages.text, {
                  count: text.length.toLocaleString(intl.locale),
                })}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent
            side="top"
            align="start"
            sideOffset={8}
            collisionPadding={12}
            className="!bg-background-primary !text-text-primary !p-0 w-[min(26rem,calc(100vw-2rem))] border border-border-primary rounded-xl shadow-lg"
            arrowClassName="!bg-background-primary !fill-background-primary"
            onMouseEnter={() => preview(true)}
            onMouseLeave={() => preview(false, 120)}
          >
            <pre
              tabIndex={0}
              data-pasted-text-hover
              className="max-h-[min(22rem,50vh)] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5 text-left"
            >
              {text.slice(0, PREVIEW_LIMIT)}
            </pre>
            <p className="border-t border-border-primary px-3 py-2 text-xs text-text-secondary">
              {intl.formatMessage(messages.text, {
                count: text.length.toLocaleString(intl.locale),
              })}
            </p>
            <p className="px-3 pb-2 text-xs text-text-secondary">
              {intl.formatMessage(messages.preview, {
                count: Math.min(text.length, PREVIEW_LIMIT).toLocaleString(intl.locale),
              })}
            </p>
          </TooltipContent>
        </Tooltip>
        {onRemove && (
          <button
            type="button"
            className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-text-primary text-background-primary ring-2 ring-background-primary hover:bg-text-primary/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-primary"
            aria-label={intl.formatMessage(messages.remove)}
            onClick={onRemove}
          >
            <X size={12} />
          </button>
        )}
      </div>
      {failed && (
        <p role="status" className="mt-1 text-xs text-text-secondary">
          {intl.formatMessage(messages.failed)}
        </p>
      )}
    </div>
  );
}
