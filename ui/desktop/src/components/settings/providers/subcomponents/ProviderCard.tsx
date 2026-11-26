import { useEffect, useMemo, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { Switch } from '../../../ui/switch';
import { acpSetProviderEnabled } from '../../../../acp/providers';
import { selectNativeText } from '../../../../utils/nativeLocalization';
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
  onEnabledChanged?: () => void;
};

export const ProviderCard = function ProviderCard({
  provider,
  onConfigure,
  onLaunch,
  isOnboarding,
  onEnabledChanged,
}: ProviderCardProps) {
  const intl = useIntl();
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState('');
  const [savedEnabled, setSavedEnabled] = useState<boolean | null>(null);
  const enabled = savedEnabled ?? provider.enabled !== false;
  useEffect(() => { setSavedEnabled(null); }, [provider]);
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
          statusControl={!isOnboarding && provider.provider_type === 'Custom' ? (
            <span className="shrink-0" onClick={event => event.stopPropagation()}>
              <Switch variant="mono" checked={enabled} disabled={saving} aria-label={`${metadata.display_name} ${selectNativeText(intl.locale, 'connection', '连接', '連線')}`}
                onCheckedChange={async (next) => {
                  setSaving(true); setFailure('');
                  try { await acpSetProviderEnabled(provider.name, next); setSavedEnabled(next); onEnabledChanged?.(); }
                  catch { setFailure(selectNativeText(intl.locale, 'Could not change connection. Finish active tasks and retry.', '连接开关未保存，请结束使用该连接的任务后重试。', '連線開關未儲存，請結束使用此連線的任務後重試。')); }
                  finally { setSaving(false); }
                }} />
            </span>
          ) : undefined}
        />
      }
      body={
        <CardBody>
          <div className="w-full">
          {!isOnboarding && provider.provider_type === 'Custom' && <div className="mb-2" onClick={event => event.stopPropagation()}>
            <p className="text-xs text-text-secondary">
              {selectNativeText(intl.locale, enabled ? 'Enabled' : 'Disabled', enabled ? '已启用' : '已停用', enabled ? '已啟用' : '已停用')}

            </p>
            {failure && (
              <div role="alert" className="mt-2 flex items-start gap-2 rounded-md border border-border-primary bg-background-secondary p-2 text-xs leading-relaxed text-text-secondary">
                <CircleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-danger" />
                <span className="min-w-0 break-words">{failure}</span>
              </div>
            )}
          </div>}
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
          </div>
        </CardBody>
      }
    />
  );
};
