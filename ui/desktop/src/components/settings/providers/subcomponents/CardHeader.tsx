import { memo, type ReactNode } from 'react';
import { GreenCheckButton } from './buttons/CardButtons';
import { ConfiguredProviderTooltipMessage, ProviderDescription } from './utils/StringUtils';
import { useIntl } from '../../../../i18n';

interface CardHeaderProps {
  name: string;
  description: string;
  isConfigured: boolean;
  statusControl?: ReactNode;
}

// Make CardTitle a proper React component
const CardTitle = memo(({ name }: { name: string }) => {
  return <h3 className="text-base font-medium text-text-primary truncate mr-2">{name}</h3>;
});
CardTitle.displayName = 'CardTitle';

// Properly type ProviderNameAndStatus props
interface ProviderNameAndStatusProps {
  name: string;
  isConfigured: boolean;
  statusControl?: ReactNode;
}

const ProviderNameAndStatus = memo(({ name, isConfigured, statusControl }: ProviderNameAndStatusProps) => {
  const intl = useIntl();
  return (
    <div className="flex items-center justify-between w-full">
      <CardTitle name={name} />

      {/* Configured state: Green check */}
      {statusControl ?? (isConfigured && <GreenCheckButton tooltip={ConfiguredProviderTooltipMessage(intl, name)} />)}
    </div>
  );
});
ProviderNameAndStatus.displayName = 'ProviderNameAndStatus';

// Add a container div to the CardHeader
const CardHeader = memo(function CardHeader({ name, description, isConfigured, statusControl }: CardHeaderProps) {
  return (
    <>
      <ProviderNameAndStatus name={name} isConfigured={isConfigured} statusControl={statusControl} />
      <ProviderDescription description={description} />
    </>
  );
});
CardHeader.displayName = 'CardHeader';

export default CardHeader;
