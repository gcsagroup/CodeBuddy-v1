import { defineMessages, useIntl } from '../../../i18n';
import { Check } from '../../icons';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card';
import { Button } from '../../ui/button';
import { InstructionFileEditor } from '../instructions/InstructionFileEditor';

const i18n = defineMessages({
  title: {
    id: 'globalInstructions.title',
    defaultMessage: 'CodeBuddy rules',
  },
  description: {
    id: 'globalInstructions.description',
    defaultMessage:
      'Provide rules for every new conversation on this computer. Project rules override conflicting global rules.',
  },
  placeholder: {
    id: 'globalInstructions.placeholder',
    defaultMessage: 'Enter your global rules here...',
  },
  unavailable: {
    id: 'globalInstructions.unavailable',
    defaultMessage: 'The CodeBuddy home directory is unavailable.',
  },
  savedSuccessfully: {
    id: 'goosehintsModal.savedSuccessfully',
    defaultMessage: 'Saved successfully',
  },
  saving: {
    id: 'goosehintsModal.saving',
    defaultMessage: 'Saving...',
  },
  save: {
    id: 'goosehintsModal.save',
    defaultMessage: 'Save',
  },
});

export const GlobalInstructionsSection = () => {
  const intl = useIntl();
  const homeDirectory = window.appConfig.get('CODEBUDDY_HOME');

  return (
    <Card className="border-border-primary shadow-none">
      <CardHeader className="border-b border-border-primary">
        <CardTitle className="font-semibold">{intl.formatMessage(i18n.title)}</CardTitle>
        <CardDescription>{intl.formatMessage(i18n.description)}</CardDescription>
      </CardHeader>
      <CardContent>
        {typeof homeDirectory === 'string' && homeDirectory.trim() ? (
          <InstructionFileEditor
            directory={homeDirectory}
            placeholder={intl.formatMessage(i18n.placeholder)}
            textareaClassName="min-h-56 max-h-[55vh] font-mono leading-relaxed"
            renderActions={({ isSaving, saveFile, saveSuccess }) => (
              <div className="mt-3 flex flex-wrap items-center justify-end gap-3 border-t border-border-primary pt-3">
                {saveSuccess && (
                  <span role="status" className="mr-auto flex items-center gap-1 text-sm text-green-700 dark:text-green-300">
                    <Check className="h-4 w-4" />
                    {intl.formatMessage(i18n.savedSuccessfully)}
                  </span>
                )}
                <Button onClick={() => void saveFile()} disabled={isSaving}>
                  {isSaving ? intl.formatMessage(i18n.saving) : intl.formatMessage(i18n.save)}
                </Button>
              </div>
            )}
          />
        ) : (
          <p role="alert" className="rounded-lg border border-border-primary bg-background-secondary p-3 text-sm text-red-700 dark:text-red-300">
            {intl.formatMessage(i18n.unavailable)}
          </p>
        )}
      </CardContent>
    </Card>
  );
};
