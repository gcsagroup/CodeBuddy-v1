import { Button } from '../../ui/button';
import { Check } from '../../icons';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import { defineMessages, useIntl } from '../../../i18n';
import { InstructionFileEditor } from '../instructions/InstructionFileEditor';

const i18n = defineMessages({
  dialogTitle: {
    id: 'goosehintsModal.dialogTitle',
    defaultMessage: 'Project instructions (AGENTS.md)',
  },
  dialogDescription: {
    id: 'goosehintsModal.dialogDescription',
    defaultMessage:
      'Define the project rules that CodeBuddy applies to new conversations in this workspace.',
  },
  helpText1: {
    id: 'goosehintsModal.helpText1',
    defaultMessage:
      'AGENTS.md is the standard project instruction file. Keep stable development rules, test requirements, and project conventions here.',
  },
  helpText2: {
    id: 'goosehintsModal.helpText2',
    defaultMessage:
      'Changes apply to new conversations. Existing conversations keep the instructions that were loaded when they started.',
  },
  savedSuccessfully: {
    id: 'goosehintsModal.savedSuccessfully',
    defaultMessage: 'Saved successfully',
  },
  close: {
    id: 'goosehintsModal.close',
    defaultMessage: 'Close',
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

const HelpText = () => {
  const intl = useIntl();

  return (
    <div className="text-sm flex-col space-y-4 text-text-secondary">
      <p>{intl.formatMessage(i18n.helpText1)}</p>
      <p>{intl.formatMessage(i18n.helpText2)}</p>
    </div>
  );
};

interface GoosehintsModalProps {
  directory: string;
  setIsGoosehintsModalOpen: (isOpen: boolean) => void;
}

export const GoosehintsModal = ({ directory, setIsGoosehintsModalOpen }: GoosehintsModalProps) => {
  const intl = useIntl();

  return (
    <Dialog open={true} onOpenChange={(open) => setIsGoosehintsModalOpen(open)}>
      <DialogContent className="w-[80vw] max-w-[80vw] sm:max-w-[80vw] max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage(i18n.dialogTitle)}</DialogTitle>
          <DialogDescription>{intl.formatMessage(i18n.dialogDescription)}</DialogDescription>
        </DialogHeader>

        <InstructionFileEditor
          beforeEditor={<HelpText />}
          className="flex-1 overflow-y-auto space-y-4 pt-2 pb-4"
          directory={directory}
          renderActions={({ isSaving, saveFile, saveSuccess }) => (
            <DialogFooter>
              {saveSuccess && (
                <span className="text-green-600 text-sm flex items-center gap-1 mr-auto">
                  <Check className="w-4 h-4" />
                  {intl.formatMessage(i18n.savedSuccessfully)}
                </span>
              )}
              <Button variant="outline" onClick={() => setIsGoosehintsModalOpen(false)}>
                {intl.formatMessage(i18n.close)}
              </Button>
              <Button onClick={saveFile} disabled={isSaving}>
                {isSaving ? intl.formatMessage(i18n.saving) : intl.formatMessage(i18n.save)}
              </Button>
            </DialogFooter>
          )}
        />
      </DialogContent>
    </Dialog>
  );
};
