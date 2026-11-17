import { ResponseStylesSection } from '../response_styles/ResponseStylesSection';
import { GlobalInstructionsSection } from './GlobalInstructionsSection';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card';
import { defineMessages, useIntl } from '../../../i18n';
import { FileText, ListTree } from 'lucide-react';
import SettingsMenu from '../SettingsMenu';

const i18n = defineMessages({
  instructions: { id: 'globalInstructions.title', defaultMessage: 'CodeBuddy rules' },
  instructionsDescription: {
    id: 'globalInstructions.description',
    defaultMessage:
      'Provide rules for every new conversation on this computer. Project rules override conflicting global rules.',
  },
  responseStylesTitle: {
    id: 'chatSettings.responseStylesTitle',
    defaultMessage: 'Tool Process Display',
  },
  responseStylesDescription: {
    id: 'chatSettings.responseStylesDescription',
    defaultMessage: 'Choose whether tool-call details are expanded or collapsed by default.',
  },
});

export default function ChatSettingsSection() {
  const intl = useIntl();

  return (
    <SettingsMenu
      layout="cards"
      items={[
        {
          id: 'instructions',
          keepAlive: true,
          title: intl.formatMessage(i18n.instructions),
          description: intl.formatMessage(i18n.instructionsDescription),
          icon: <FileText className="h-5 w-5" />,
          content: <GlobalInstructionsSection />,
        },
        {
          id: 'display',
          title: intl.formatMessage(i18n.responseStylesTitle),
          description: intl.formatMessage(i18n.responseStylesDescription),
          icon: <ListTree className="h-5 w-5" />,
          content: (
            <Card className="border-border-primary shadow-none">
              <CardHeader className="border-b border-border-primary">
                <CardTitle className="font-semibold">{intl.formatMessage(i18n.responseStylesTitle)}</CardTitle>
                <CardDescription>
                  {intl.formatMessage(i18n.responseStylesDescription)}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ResponseStylesSection />
              </CardContent>
            </Card>
          ),
        },
      ]}
    />
  );
}
