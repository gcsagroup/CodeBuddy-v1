import { Github } from 'lucide-react';
import { defineMessages, useIntl } from '../../../i18n';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card';
import GitHubConnections from './GitHubConnections';

const i18n = defineMessages({
  title: { id: 'githubAuth.title', defaultMessage: 'GitHub' },
  description: {
    id: 'githubAuth.description',
    defaultMessage: 'Connect GitHub for repository and pull request actions.',
  },
});

export default function GitHubAuthCard() {
  const intl = useIntl();
  return (
    <Card className="pb-2">
      <CardHeader className="pb-0">
        <CardTitle className="flex items-center gap-2">
          <Github className="h-4 w-4" />
          {intl.formatMessage(i18n.title)}
        </CardTitle>
        <CardDescription>{intl.formatMessage(i18n.description)}</CardDescription>
      </CardHeader>
      <CardContent className="px-4 py-2">
        <GitHubConnections allowLogin />
      </CardContent>
    </Card>
  );
}
