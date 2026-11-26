import { useEffect, useState } from 'react';
import { Folder, Pencil } from 'lucide-react';
import { getAcpControlClient } from '../../acp/acpConnection';
import { useIntl } from '../../i18n';
import { errorMessage } from '../../utils/conversionUtils';
import { projectEditorMessages } from './ProjectEditor';

export const PROJECT_FOLDERS_CHANGED = 'codebuddy-project-folders-changed';

export function ProjectFolderSummary({ cwd, onEdit }: { cwd: string; onEdit: () => void }) {
  const intl = useIntl();
  const [folders, setFolders] = useState<{ path: string; access: string }[]>();
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    let revision = 0;
    const refresh = () => {
      const current = ++revision;
      setError('');
      void getAcpControlClient().then(client => client.extMethod('_codebuddy/project-folders/get', { cwd }))
        .then(result => {
          if (live && current === revision) setFolders((result as { folders: { path: string; access: string }[] }).folders);
        }).catch(reason => { if (live && current === revision) setError(errorMessage(reason)); });
    };
    refresh();
    window.addEventListener(PROJECT_FOLDERS_CHANGED, refresh);
    return () => { live = false; window.removeEventListener(PROJECT_FOLDERS_CHANGED, refresh); };
  }, [cwd]);
  return <div className="mt-2 border-t border-border-primary pt-2">
    <div className="max-h-52 overflow-y-auto space-y-2" aria-label={intl.formatMessage(projectEditorMessages.linked)}>
      {[{ path: cwd, access: 'primary' }, ...(folders ?? [])].map(folder => <div key={folder.path} className="flex items-start gap-2 text-xs leading-5">
        <Folder className="mt-0.5 size-4 shrink-0 text-text-secondary" aria-hidden="true" />
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{folder.path}</span>
        {folder.access !== 'write' && <span className="shrink-0 rounded-md bg-background-secondary px-1.5 text-text-secondary">
          {intl.formatMessage(folder.access === 'primary' ? projectEditorMessages.main : projectEditorMessages.reference)}
        </span>}
      </div>)}
    </div>
    {error && <p role="alert" className="mt-2 text-xs text-text-secondary">{error}</p>}
    <button type="button" onClick={onEdit} className="mt-2 flex w-full items-center gap-2 rounded-md border-t border-border-primary px-1 py-2 text-sm hover:bg-background-secondary focus-visible:ring-2 focus-visible:ring-ring">
      <Pencil className="size-4" />{intl.formatMessage(projectEditorMessages.edit)}
    </button>
  </div>;
}
