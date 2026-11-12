import { SecurityToggle } from './SecurityToggle';
import { Card, CardContent, CardDescription, CardHeader } from '../../ui/card';
import { defineMessages, useIntl } from '../../../i18n';

const i18n = defineMessages({
  title: {
    id: 'securitySettings.title',
    defaultMessage: 'Security and permissions',
  },
  description: {
    id: 'securitySettings.description',
    defaultMessage:
      'Control prompt-injection detection. Tool permissions remain enforced at action time.',
  },
});

export default function SecurityAndPermissionsSection() {
  const intl = useIntl();

  return (
    <section aria-label={intl.formatMessage(i18n.title)}>
      <Card className="rounded-lg pb-2">
        <CardHeader className="pb-0">
          <CardDescription>{intl.formatMessage(i18n.description)}</CardDescription>
        </CardHeader>
        <CardContent className="px-2">
          <SecurityToggle />
        </CardContent>
      </Card>
    </section>
  );
}
