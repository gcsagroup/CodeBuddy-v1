import { Check, ChevronRight, Copy } from 'lucide-react';
import { useId, useState } from 'react';
import { defineMessages, useIntl } from '../i18n';
import './ui/disclosure.css';

const i18n = defineMessages({
  expand: {
    id: 'technicalValue.expand',
    defaultMessage: 'Expand {label}',
  },
  collapse: {
    id: 'technicalValue.collapse',
    defaultMessage: 'Collapse {label}',
  },
  copy: {
    id: 'technicalValue.copy',
    defaultMessage: 'Copy {label}',
  },
  copied: {
    id: 'technicalValue.copied',
    defaultMessage: '{label} copied',
  },
  copyFailed: {
    id: 'technicalValue.copyFailed',
    defaultMessage: 'Failed to copy {label}',
  },
});

export interface TechnicalValueProps {
  value: string;
  label: string;
  initiallyExpanded?: boolean;
  maxPreviewLines?: number;
}

export function TechnicalValue({
  value,
  label,
  initiallyExpanded = false,
  maxPreviewLines = 3,
}: TechnicalValueProps) {
  const intl = useIntl();
  const contentId = useId();
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const toggleLabel = intl.formatMessage(expanded ? i18n.collapse : i18n.expand, { label });
  const copyLabel = intl.formatMessage(i18n.copy, { label });

  const copyValue = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  return (
    <div className="min-w-0 max-w-full rounded-md border border-border-primary bg-background-primary">
      <div className="flex min-w-0 items-center justify-between gap-2 border-b border-border-primary px-2 py-1">
        <button
          type="button"
          aria-controls={contentId}
          aria-expanded={expanded}
          aria-label={toggleLabel}
          title={toggleLabel}
          className="flex min-w-0 items-center gap-1.5 rounded py-1 text-left text-xs font-medium text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-primary"
          onClick={() => setExpanded((current) => !current)}
        >
          <span className="truncate">{label}</span>
          <ChevronRight
            className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          aria-label={copyLabel}
          title={copyLabel}
          className="rounded p-1 text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-primary"
          onClick={copyValue}
        >
          {copyState === 'copied' ? (
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </button>
      </div>
      <code
        id={contentId}
        className="codepro-disclosure-preview block min-w-0 max-w-full overflow-hidden whitespace-pre-wrap break-all px-2 py-1.5 text-xs text-text-primary"
        style={{ maxHeight: expanded ? 'max-content' : `calc(${maxPreviewLines}lh + 0.75rem)` }}
      >
        {value}
      </code>
      {copyState !== 'idle' && (
        <p className="px-2 pb-1.5 text-xs text-text-secondary" role="status">
          {intl.formatMessage(copyState === 'copied' ? i18n.copied : i18n.copyFailed, { label })}
        </p>
      )}
    </div>
  );
}
