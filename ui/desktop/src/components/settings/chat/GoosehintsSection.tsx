import { useEffect, useRef, useState } from 'react';
import { Button } from '../../ui/button';
import { FolderKey } from 'lucide-react';
import { GoosehintsModal } from './GoosehintsModal';
import { defineMessages, useIntl } from '../../../i18n';
import { useChatContext } from '../../../contexts/ChatContext';
import { acpGetSessionListItem } from '../../../acp/sessions';
import { chooseOrdinaryWorkingDir, getInitialWorkingDir } from '../../../utils/workingDir';

const i18n = defineMessages({
  title: {
    id: 'goosehintsSection.title',
    defaultMessage: 'Project instructions (AGENTS.md)',
  },
  description: {
    id: 'goosehintsSection.description',
    defaultMessage: 'Set development rules, test requirements, and conventions for this project',
  },
  configure: {
    id: 'goosehintsSection.configure',
    defaultMessage: 'Configure',
  },
  chooseFolder: {
    id: 'app.chooseFolder',
    defaultMessage: 'Choose folder',
  },
});

export const GoosehintsSection = () => {
  const intl = useIntl();
  const chatContext = useChatContext();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [directory, setDirectory] = useState('');
  const [isLoadingDirectory, setIsLoadingDirectory] = useState(false);
  const directoryRequestGeneration = useRef(0);
  const sessionId = chatContext?.chat.sessionId?.trim() ?? '';

  const handleConfigure = async () => {
    if (directory) {
      setIsModalOpen(true);
      return;
    }
    if (sessionId || isLoadingDirectory) return;

    const selectedDirectory = await chooseOrdinaryWorkingDir(getInitialWorkingDir());
    if (!selectedDirectory) return;
    setDirectory(selectedDirectory);
    setIsModalOpen(true);
  };

  useEffect(() => {
    const generation = ++directoryRequestGeneration.current;
    setDirectory('');
    setIsModalOpen(false);

    if (!sessionId) {
      setDirectory(getInitialWorkingDir());
      setIsLoadingDirectory(false);
      return;
    }

    setIsLoadingDirectory(true);
    void acpGetSessionListItem(sessionId)
      .then((session) => {
        if (directoryRequestGeneration.current !== generation) {
          return;
        }
        setDirectory(session.workingDir.trim() ? session.workingDir : '');
      })
      .catch(() => {
        if (directoryRequestGeneration.current === generation) {
          setDirectory('');
        }
      })
      .finally(() => {
        if (directoryRequestGeneration.current === generation) {
          setIsLoadingDirectory(false);
        }
      });

    return () => {
      if (directoryRequestGeneration.current === generation) {
        directoryRequestGeneration.current += 1;
      }
    };
  }, [sessionId]);

  return (
    <>
      <div className="flex items-center justify-between px-2 py-2">
        <div className="flex-1">
          <h3 className="text-text-primary">{intl.formatMessage(i18n.title)}</h3>
          <p className="text-xs text-text-secondary mt-[2px]">
            {intl.formatMessage(i18n.description)}
          </p>
        </div>
        <Button
          onClick={() => void handleConfigure()}
          disabled={isLoadingDirectory || (!!sessionId && !directory)}
          variant="outline"
          size="sm"
          className="flex items-center gap-2"
        >
          <FolderKey size={16} />
          {intl.formatMessage(directory || sessionId ? i18n.configure : i18n.chooseFolder)}
        </Button>
      </div>
      {isModalOpen && directory && (
        <GoosehintsModal directory={directory} setIsGoosehintsModalOpen={setIsModalOpen} />
      )}
    </>
  );
};
