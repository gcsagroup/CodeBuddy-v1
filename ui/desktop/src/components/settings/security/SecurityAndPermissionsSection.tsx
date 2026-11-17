import { ShieldCheck } from 'lucide-react';
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
      <Card className="@container gap-0 border-border-primary py-0 shadow-none">
        <CardHeader className="border-b border-border-primary px-4 py-4 @sm:px-5">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background-secondary">
              <ShieldCheck className="size-5 text-text-secondary" aria-hidden="true" />
            </span>
            <CardDescription className="self-center leading-relaxed">
              {intl.formatMessage(i18n.description)}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="px-4 @sm:px-5">
          <SecurityToggle />
        </CardContent>
      </Card>
    </section>
  );
}
