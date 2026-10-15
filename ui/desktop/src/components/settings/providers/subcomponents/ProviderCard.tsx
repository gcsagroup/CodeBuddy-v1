import { useMemo } from 'react';
import CardContainer from './CardContainer';
import CardHeader from './CardHeader';
import CardBody from './CardBody';
import DefaultCardButtons from './buttons/DefaultCardButtons';
import {
  providerActivationDisabledReason,
  type ProviderDetails,
  type ProviderMetadata,
} from '../../../../types/providers';
import { defineMessages, useIntl } from '../../../../i18n';

const i18n = defineMessages({
  noMetadata: {
    id: 'providerCard.noMetadata',
    defaultMessage: 'ProviderCard error: No metadata provided',
  },
  unknownProvider: {
    id: 'providerCard.unknownProvider',
    defaultMessage: 'Unknown Provider',
  },
});

type ProviderCardProps = {
  provider: ProviderDetails;
  onConfigure: () => void;
  onLaunch: () => void;
  isOnboarding: boolean;
};

export const ProviderCard = function ProviderCard({
  provider,
  onConfigure,
  onLaunch,
  isOnboarding,
}: ProviderCardProps) {
  const intl = useIntl();
  // Safely access metadata with null checks
  const providerMetadata: ProviderMetadata | null = provider?.metadata || null;

  // Instead of useEffect for logging, use useMemo to memoize the metadata
  const metadata = useMemo(() => providerMetadata, [providerMetadata]);

  if (!metadata) {
    return <div>{intl.formatMessage(i18n.noMetadata)}</div>;
  }

  const disabledReason = providerActivationDisabledReason(provider);

  const handleCardClick = () => {
    if (!disabledReason && !isOnboarding) {
      onConfigure();
    }
  };

  return (
    <CardContainer
      testId={`provider-card-${provider.name.toLowerCase()}`}
      grayedOut={Boolean(disabledReason) || (!provider.is_configured && isOnboarding)}
      onClick={handleCardClick}
      header={
        <CardHeader
          name={metadata.display_name || provider?.name || intl.formatMessage(i18n.unknownProvider)}
          description={metadata.description || ''}
          isConfigured={provider?.is_configured || false}
        />
      }
      body={
        <CardBody>
          {disabledReason ? (
            <p className="text-xs text-red-500" role="status">
              {disabledReason}
            </p>
          ) : (
            <DefaultCardButtons
              provider={provider}
              onConfigure={onConfigure}
              onLaunch={onLaunch}
              isOnboardingPage={isOnboarding}
            />
          )}
        </CardBody>
      }
    />
  );
};
