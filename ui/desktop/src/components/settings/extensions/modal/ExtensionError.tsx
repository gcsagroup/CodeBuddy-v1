import { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { defineMessages, useIntl } from '../../../../i18n';

const messages = defineMessages({
  saveFailed: { id: 'extensionError.saveFailed', defaultMessage: 'Extension was not saved' },
  testFailed: { id: 'extensionError.testFailed', defaultMessage: 'Connection test failed' },
  notFound: {
    id: 'extensionError.notFound',
    defaultMessage:
      'HTTP 404: The server responded, but this MCP endpoint was not found. Check the port and full endpoint path with the service owner.',
  },
  http: {
    id: 'extensionError.http',
    defaultMessage:
      'The server returned HTTP {status}. Check the endpoint and service configuration. Details are available below.',
  },
  generic: {
    id: 'extensionError.generic',
    defaultMessage:
      'The operation failed. Your input has been kept. Review the error details, correct the configuration, and retry.',
  },
  details: { id: 'extensionError.details', defaultMessage: 'Error details' },
});

export default function ExtensionError({
  error,
  operation,
}: {
  error: string;
  operation: 'save' | 'test';
}) {
  const intl = useIntl();
  const alert = useRef<HTMLDivElement>(null);
  // This only extracts an explicit HTTP status for display; it does not alter retry or save logic.
  const status = /\bHTTP(?:\/\d(?:\.\d)?)?\s+([45]\d{2})\b/i.exec(error)?.[1];
  useEffect(() => {
    alert.current?.focus({ preventScroll: true });
  }, [error, operation]);

  return (
    <div
      ref={alert}
      role="alert"
      tabIndex={-1}
      className="min-w-0 shrink-0 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-text-primary [overflow-wrap:anywhere]"
    >
      <div className="flex items-center gap-2 font-semibold text-red-600 dark:text-red-400">
        <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
        {intl.formatMessage(operation === 'save' ? messages.saveFailed : messages.testFailed)}
      </div>
      <p className="mt-1">
        {intl.formatMessage(
          status === '404' ? messages.notFound : status ? messages.http : messages.generic,
          { status }
        )}
      </p>
      <details className="mt-2 min-w-0">
        <summary className="cursor-pointer font-medium">
          {intl.formatMessage(messages.details)}
        </summary>
        <pre
          className="mt-2 max-h-[18vh] overflow-y-auto whitespace-pre-wrap text-xs [overflow-wrap:anywhere]"
          tabIndex={0}
        >
          {error}
        </pre>
      </details>
    </div>
  );
}
