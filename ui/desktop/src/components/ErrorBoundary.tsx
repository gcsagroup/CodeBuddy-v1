import React from 'react';
import { Button } from './ui/button';
import { AlertTriangle } from 'lucide-react';
import { trackError, trackEvent } from '../utils/analytics';
import { rendererDiagnostic } from '../utils/rendererDiagnostics';
import { defineMessages, useIntl } from '../i18n';

const i18n = defineMessages({
  heading: {
    id: 'errorBoundary.heading',
    defaultMessage: 'Something went wrong',
  },
  errorWithVersion: {
    id: 'errorBoundary.errorWithVersion',
    defaultMessage: 'An error occurred in CodeBuddy v{version}.',
  },
  errorGeneric: {
    id: 'errorBoundary.errorGeneric',
    defaultMessage: 'An error occurred.',
  },
  reload: {
    id: 'errorBoundary.reload',
    defaultMessage: 'Reload',
  },
});

// Keep diagnostic failures out of the recovery path. Capture frames, not error
// payloads or chat content; correlate the timestamp with existing stream logs.
function logRendererCrash(
  error: unknown,
  source: 'react_boundary' | 'window_error' | 'unhandled_rejection',
  componentStack?: string | null
) {
  try {
    window.electron.logInfo(
      JSON.stringify({
        tag:
          source === 'window_error'
            ? 'renderer_window_error'
            : source === 'unhandled_rejection'
              ? 'renderer_unhandled_rejection'
              : 'renderer_crash',
        at_ms: Date.now(),
        ...rendererDiagnostic(error, source, componentStack),
      })
    );
  } catch {
    // The original error UI must still be available if logging is unavailable.
  }
}

if (import.meta.env.DEV) {
  try {
    window.electron.logInfo(
      JSON.stringify({
        tag: 'renderer_diagnostics_ready',
        diagnostic_revision: 'renderer-safe-v1',
        at_ms: Date.now(),
      })
    );
  } catch {
    // Diagnostic readiness is not a prerequisite for rendering.
  }
}

// Capture unhandled promise rejections
window.addEventListener('unhandledrejection', (event) => {
  logRendererCrash(event.reason, 'unhandled_rejection');
  trackError(rendererDiagnostic(event.reason, 'unhandled_rejection').code, {
    component: 'global',
    action: 'async_operation',
    recoverable: false,
  });
});

// Capture global errors
window.addEventListener('error', (event) => {
  logRendererCrash(event.error, 'window_error');
  trackError(rendererDiagnostic(event.error, 'window_error').code, {
    component: 'global',
    action: 'script_execution',
    recoverable: false,
  });
});

export function ErrorUI({ error }: { error: unknown }) {
  const intl = useIntl();
  const handleReload = () => {
    trackEvent({
      name: 'app_reloaded',
      properties: { reason: 'error_recovery' },
    });
    window.electron.reloadApp();
  };

  const version = window?.appConfig?.get('GOOSE_VERSION') as string | undefined;

  return (
    <div className="fixed inset-0 w-full h-full flex flex-col items-center justify-center gap-6 bg-background">
      <div className="flex flex-col items-center gap-4 max-w-[600px] text-center px-6">
        <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mb-2">
          <AlertTriangle className="w-8 h-8 text-destructive" />
        </div>

        <h1 className="text-2xl font-semibold text-foreground dark:text-white">
          {intl.formatMessage(i18n.heading)}
        </h1>

        <p className="text-base text-text-secondary dark:text-muted-foreground mb-2">
          {version !== undefined
            ? intl.formatMessage(i18n.errorWithVersion, { version })
            : intl.formatMessage(i18n.errorGeneric)}
        </p>

        <pre className="text-destructive text-sm dark:text-white p-4 bg-muted rounded-lg w-full overflow-auto border border-border whitespace-pre-wrap">
          {JSON.stringify(rendererDiagnostic(error, 'react_boundary'), null, 2)}
        </pre>

        <Button onClick={handleReload}>{intl.formatMessage(i18n.reload)}</Button>
      </div>
    </div>
  );
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null; hasError: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    logRendererCrash(error, 'react_boundary', errorInfo.componentStack);
    const diagnostic = rendererDiagnostic(error, 'react_boundary', errorInfo.componentStack);

    trackEvent({
      name: 'app_crashed',
      properties: {
        error_type: diagnostic.code,
        component: diagnostic.components?.[0],
      },
    });
  }

  render() {
    if (this.state.hasError) {
      return <ErrorUI error={this.state.error} />;
    }
    return this.props.children;
  }
}
