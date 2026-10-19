import { useEffect, useRef, useState } from 'react';
import { acpListProviderDetails } from '../../acp/providers';
import { CodeBuddyMark } from '../CodeBuddyMark';
import { Button } from '../ui/button';
import { defineMessages, useIntl } from '../../i18n';
import { LoaderCircle } from 'lucide-react';

const i18n = defineMessages({
  configureTitle: {
    id: 'onboardingGuard.configureTitle',
    defaultMessage: 'Connect a model to get started',
  },
  configureDescription: {
    id: 'onboardingGuard.configureDescription',
    defaultMessage: 'Add your model provider in settings, then choose a model in the chat.',
  },
  checkProviderErrorTitle: {
    id: 'onboardingGuard.checkProviderErrorTitle',
    defaultMessage: 'Unable to connect to CodeBuddy server',
  },
  checkProviderErrorDescription: {
    id: 'onboardingGuard.checkProviderErrorDescription',
    defaultMessage: 'The server may be starting up or temporarily unavailable.',
  },
  retry: {
    id: 'onboardingGuard.retry',
    defaultMessage: 'Retry',
  },
  configureModel: {
    id: 'onboardingGuard.configureModel',
    defaultMessage: 'Open model settings',
  },
  loadingProviders: {
    id: 'providerSettings.loadingProviders',
    defaultMessage: 'Loading providers...',
  },
});

interface OnboardingGuardProps {
  children: React.ReactNode;
  onConfigure: () => void;
  requireModel?: boolean;
}

export default function OnboardingGuard({
  children,
  onConfigure,
  requireModel = true,
}: OnboardingGuardProps) {
  const intl = useIntl();
  const pending = useRef<Promise<boolean> | null>(null);
  const [checkState, setCheckState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!requireModel) return;
    let cancelled = false;
    setCheckState('loading');
    // The runtime owns configured connections. Opening the app only reads them;
    // model selection belongs to the chat, so defaults need not be set yet.
    pending.current ??= acpListProviderDetails()
      .then((providers) =>
        providers.some(
          (provider) => provider.is_configured && provider.metadata.known_models.length > 0
        )
      )
      .finally(() => {
        pending.current = null;
      });
    pending.current.then(
      (configured) => {
        if (!cancelled) setCheckState(configured ? 'ready' : 'empty');
      },
      (error) => {
        console.error('Failed to read model connections:', error);
        if (!cancelled) setCheckState('error');
      }
    );
    return () => {
      cancelled = true;
    };
  }, [requireModel, attempt]);

  // Settings must remain reachable even if the connection inventory cannot load.
  if (!requireModel || checkState === 'ready') return <>{children}</>;

  if (checkState === 'loading') {
    return (
      <div
        role="status"
        aria-live="polite"
        className="h-screen w-full bg-background-default flex flex-col items-center justify-center"
      >
        <CodeBuddyMark className="size-8" />
        <div className="mt-4 flex items-center gap-2 text-sm text-text-muted">
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          <span>{intl.formatMessage(i18n.loadingProviders)}</span>
        </div>
        <Button variant="outline" className="mt-6" onClick={onConfigure}>
          {intl.formatMessage(i18n.configureModel)}
        </Button>
      </div>
    );
  }

  const failed = checkState === 'error';
  return (
    <div className="h-screen w-full bg-background-default flex flex-col items-center justify-center">
      <div className="text-center max-w-md">
        <div className="mb-4">
          <CodeBuddyMark className="size-8 mx-auto" />
        </div>
        <h1 className="text-xl font-light mb-3">
          {intl.formatMessage(failed ? i18n.checkProviderErrorTitle : i18n.configureTitle)}
        </h1>
        <p className="text-text-muted mb-6">
          {intl.formatMessage(
            failed ? i18n.checkProviderErrorDescription : i18n.configureDescription
          )}
        </p>
        <div className="flex justify-center gap-3">
          <Button onClick={onConfigure}>{intl.formatMessage(i18n.configureModel)}</Button>
          {failed && (
            <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
              {intl.formatMessage(i18n.retry)}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
