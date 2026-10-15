import { type ReactNode, useEffect, useState } from 'react';
import { defineMessages, useIntl } from '../../../i18n';
import { errorMessage } from '../../../utils/conversionUtils';
import { Check } from '../../icons';
import { Button } from '../../ui/button';

const i18n = defineMessages({
  errorReading: {
    id: 'goosehintsModal.errorReading',
    defaultMessage: 'Error reading AGENTS.md file: {error}',
  },
  fileFound: {
    id: 'goosehintsModal.fileFound',
    defaultMessage: 'AGENTS.md found at: {filePath}',
  },
  fileCreating: {
    id: 'goosehintsModal.fileCreating',
    defaultMessage: 'A new AGENTS.md will be created at: {filePath}',
  },
  placeholder: {
    id: 'goosehintsModal.placeholder',
    defaultMessage: 'Enter project instructions here...',
  },
  failedToAccess: {
    id: 'goosehintsModal.failedToAccess',
    defaultMessage: 'Failed to access AGENTS.md file',
  },
  failedToSave: {
    id: 'goosehintsModal.failedToSave',
    defaultMessage: 'Failed to save AGENTS.md file',
  },
  conflictDetected: {
    id: 'goosehintsModal.conflictDetected',
    defaultMessage:
      'AGENTS.md changed before the save check. Reload before saving to avoid overwriting that newer version.',
  },
  legacyFound: {
    id: 'goosehintsModal.legacyFound',
    defaultMessage: 'Legacy project rules were found in {name}.',
  },
  legacyImportDescription: {
    id: 'goosehintsModal.legacyImportDescription',
    defaultMessage:
      'Importing copies the content into this editor. The legacy file is not changed or deleted.',
  },
  importLegacy: {
    id: 'goosehintsModal.importLegacy',
    defaultMessage: 'Import into AGENTS.md',
  },
});

const readInstructionFile = async (filePath: string) => await window.electron.readFile(filePath);

const isMissingFileError = (error: unknown) => {
  if (!error) return false;
  if (typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return true;
  return String(error).includes('ENOENT');
};

const ErrorDisplay = ({ error }: { error: Error }) => {
  const intl = useIntl();

  return (
    <div className="text-sm text-text-secondary">
      <div className="text-red-600">
        {intl.formatMessage(i18n.errorReading, { error: errorMessage(error) })}
      </div>
    </div>
  );
};

const FileInfo = ({ filePath, found }: { filePath: string; found: boolean }) => {
  const intl = useIntl();

  return (
    <div className="text-sm font-medium mb-2">
      {found ? (
        <div className="text-green-600">
          <Check className="w-4 h-4 inline-block" />{' '}
          {intl.formatMessage(i18n.fileFound, { filePath })}
        </div>
      ) : (
        <div>{intl.formatMessage(i18n.fileCreating, { filePath })}</div>
      )}
    </div>
  );
};

export interface InstructionFileEditorActions {
  isSaving: boolean;
  saveFile: () => Promise<void>;
  saveSuccess: boolean;
}

interface InstructionFileEditorProps {
  beforeEditor?: ReactNode;
  className?: string;
  directory: string;
  placeholder?: string;
  renderActions: (actions: InstructionFileEditorActions) => ReactNode;
  textareaClassName?: string;
}

export const InstructionFileEditor = ({
  beforeEditor,
  className,
  directory,
  placeholder,
  renderActions,
  textareaClassName = 'h-80',
}: InstructionFileEditorProps) => {
  const intl = useIntl();
  const agentsFilePath = `${directory}/AGENTS.md`;
  const [instructionFilePath, setInstructionFilePath] = useState(agentsFilePath);
  const [instructionFile, setInstructionFile] = useState('');
  const [instructionFileFound, setInstructionFileFound] = useState(false);
  const [loadedInstructionFile, setLoadedInstructionFile] = useState('');
  const [loadedInstructionFileFound, setLoadedInstructionFileFound] = useState(false);
  const [instructionFileReadError, setInstructionFileReadError] = useState('');
  const [legacySource, setLegacySource] = useState<{ name: string; content: string } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    const fetchInstructionFile = async () => {
      try {
        setInstructionFilePath(agentsFilePath);
        setInstructionFile('');
        setInstructionFileFound(false);
        setLoadedInstructionFile('');
        setLoadedInstructionFileFound(false);
        setInstructionFileReadError('');
        setLegacySource(null);

        for (const filePath of [`${directory}/AGENTS.override.md`, agentsFilePath]) {
          const candidate = await readInstructionFile(filePath);
          if (candidate.found || (candidate.error && !isMissingFileError(candidate.error))) {
            setInstructionFilePath(filePath);
            setInstructionFile(candidate.file);
            setInstructionFileFound(candidate.found);
            setLoadedInstructionFile(candidate.file);
            setLoadedInstructionFileFound(candidate.found);
            setInstructionFileReadError(candidate.error ?? '');
            return;
          }
        }

        for (const name of ['.codebuddyhints', '.goosehints']) {
          const legacy = await readInstructionFile(`${directory}/${name}`);
          if (legacy.found && !legacy.error) {
            setLegacySource({ name, content: legacy.file });
            break;
          }
          if (legacy.error && !isMissingFileError(legacy.error)) {
            setInstructionFileReadError(String(legacy.error));
            return;
          }
        }
      } catch {
        setInstructionFileReadError(intl.formatMessage(i18n.failedToAccess));
      }
    };

    if (directory) void fetchInstructionFile();
  }, [agentsFilePath, directory, intl]);

  const saveFile = async () => {
    setIsSaving(true);
    setSaveSuccess(false);
    setSaveError('');
    try {
      const current = await readInstructionFile(instructionFilePath);
      if (current.error && !isMissingFileError(current.error)) {
        setSaveError(intl.formatMessage(i18n.failedToAccess));
        return;
      }
      if (
        current.found !== loadedInstructionFileFound ||
        (current.found && current.file !== loadedInstructionFile)
      ) {
        setSaveError(intl.formatMessage(i18n.conflictDetected));
        return;
      }
      const saved = await window.electron.writeFile(instructionFilePath, instructionFile);
      if (!saved) {
        setSaveError(intl.formatMessage(i18n.failedToSave));
        return;
      }
      setSaveSuccess(true);
      setInstructionFileFound(true);
      setLoadedInstructionFile(instructionFile);
      setLoadedInstructionFileFound(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch {
      setSaveError(intl.formatMessage(i18n.failedToSave));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <div className={className}>
        {beforeEditor}

        <div>
          {saveError && (
            <div role="alert" className="text-sm text-red-600 mb-2">
              {saveError}
            </div>
          )}
          {instructionFileReadError ? (
            <ErrorDisplay error={new Error(instructionFileReadError)} />
          ) : (
            <div className="space-y-2">
              <FileInfo filePath={instructionFilePath} found={instructionFileFound} />
              {legacySource && !instructionFileFound && (
                <div className="flex items-start justify-between gap-4 rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-3">
                  <div className="text-sm">
                    <p className="font-medium text-text-primary">
                      {intl.formatMessage(i18n.legacyFound, { name: legacySource.name })}
                    </p>
                    <p className="mt-1 text-xs text-text-secondary">
                      {intl.formatMessage(i18n.legacyImportDescription)}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setInstructionFile(legacySource.content)}
                  >
                    {intl.formatMessage(i18n.importLegacy)}
                  </Button>
                </div>
              )}
              <textarea
                value={instructionFile}
                className={`w-full border rounded-md p-2 text-sm resize-y bg-background-primary text-text-primary border-border-primary focus:outline-none focus:ring-2 focus:ring-blue-500 ${textareaClassName}`}
                onChange={(event) => setInstructionFile(event.target.value)}
                placeholder={placeholder ?? intl.formatMessage(i18n.placeholder)}
              />
            </div>
          )}
        </div>
      </div>

      {renderActions({ isSaving, saveFile, saveSuccess })}
    </>
  );
};
