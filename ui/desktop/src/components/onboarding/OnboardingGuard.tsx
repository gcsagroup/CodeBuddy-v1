import { useCallback, useEffect, useRef, useState } from 'react';
import { useModelAndProvider } from '../ModelAndProviderContext';
import {
  DEFAULT_LAN_PROVIDER,
  DefaultLanSetupError,
  ensureDefaultLanProvider,
} from './defaultLanProvider';
import { CodeBuddyMark } from '../CodeBuddyMark';
import { Button } from '../ui/button';
import { defineMessages, useIntl } from '../../i18n';
import { LoaderCircle } from 'lucide-react';

const i18n = defineMessages({
  setupFailed: {
    id: 'onboardingGuard.setupFailed',
    defaultMessage: 'Default model setup is not complete',
  },
  setupUnavailable: {
    id: 'onboardingGuard.setupUnavailable',
    defaultMessage:
      'Open model settings to choose a default model, or retry if the service is temporarily unavailable.',
  },
  empty: {
    id: 'onboardingGuard.emptyModels',
    defaultMessage:
      'The service returned no models. Ask the service administrator to make a model available, then retry.',
  },
  multiple: {
    id: 'onboardingGuard.multipleModels',
    defaultMessage: 'The service returned multiple models. Choose a default model in settings.',
  },
  timeout: {
    id: 'onboardingGuard.setupTimeout',
    defaultMessage: 'Model setup timed out. Check the service connection and retry.',
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
  const { refreshCurrentModelAndProvider } = useModelAndProvider();
  const pending = useRef<Promise<void> | null>(null);
  const [isCheckingProvider, setIsCheckingProvider] = useState(true);
  const [checkProviderError, setCheckProviderError] = useState(false);
  const [errorReason, setErrorReason] = useState<'empty' | 'multiple' | 'timeout' | null>(null);

  const checkProvider = useCallback(async () => {
    setIsCheckingProvider(true);
    setCheckProviderError(false);
    setErrorReason(null);
    try {
      pending.current ??= ensureDefaultLanProvider().finally(() => {
        pending.current = null;
      });
      await pending.current;
      await refreshCurrentModelAndProvider();
      setIsCheckingProvider(false);
      return;
    } catch (error) {
      setErrorReason(error instanceof DefaultLanSetupError ? error.reason : null);
      console.error('Failed to initialize default model:', error);
    }
    setCheckProviderError(true);
    setIsCheckingProvider(false);
  }, [refreshCurrentModelAndProvider]);

  useEffect(() => {
    if (requireModel) void checkProvider();
  }, [checkProvider, requireModel]);

  // Settings must remain reachable to repair the configuration this guard checks.
  if (!requireModel) return <>{children}</>;

  if (isCheckingProvider) {
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

  if (checkProviderError) {
    return (
      <div className="h-screen w-full bg-background-default flex flex-col items-center justify-center">
        <div className="text-center max-w-md">
          <div className="mb-4">
            <CodeBuddyMark className="size-8 mx-auto" />
          </div>
          <h1 className="text-xl font-light mb-3">{intl.formatMessage(i18n.setupFailed)}</h1>
          <p className="text-text-muted mb-6">
            {intl.formatMessage(errorReason ? i18n[errorReason] : i18n.setupUnavailable)}
          </p>
          <p className="text-text-muted mb-6">{DEFAULT_LAN_PROVIDER.api_url}</p>
          <div className="flex justify-center gap-3">
            <Button onClick={onConfigure}>{intl.formatMessage(i18n.configureModel)}</Button>
            <Button variant="outline" onClick={() => void checkProvider()}>
              {intl.formatMessage(i18n.retry)}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
