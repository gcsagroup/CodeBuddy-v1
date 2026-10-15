import { defineMessages, useIntl } from '../../../i18n';
import { Check } from '../../icons';
import { Button } from '../../ui/button';
import { InstructionFileEditor } from '../instructions/InstructionFileEditor';

const i18n = defineMessages({
  title: {
    id: 'globalInstructions.title',
    defaultMessage: 'CodeBuddy instructions',
  },
  description: {
    id: 'globalInstructions.description',
    defaultMessage:
      'Provide rules for every new conversation on this computer. Project instructions override conflicting global rules.',
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
    <div className="px-2 py-2">
      <div className="mb-4">
        <h3 className="text-text-primary">{intl.formatMessage(i18n.title)}</h3>
        <p className="text-xs text-text-secondary mt-[2px]">
          {intl.formatMessage(i18n.description)}
        </p>
      </div>

      {typeof homeDirectory === 'string' && homeDirectory.trim() ? (
        <InstructionFileEditor
          directory={homeDirectory}
          placeholder={intl.formatMessage(i18n.placeholder)}
          textareaClassName="min-h-44 max-h-96"
          renderActions={({ isSaving, saveFile, saveSuccess }) => (
            <div className="mt-3 flex items-center justify-end gap-3">
              {saveSuccess && (
                <span className="mr-auto flex items-center gap-1 text-sm text-green-600">
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
        <p role="alert" className="text-sm text-red-600">
          {intl.formatMessage(i18n.unavailable)}
        </p>
      )}
    </div>
  );
};
