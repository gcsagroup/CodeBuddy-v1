import { useEffect, useRef, useState } from 'react';
import { Folder, FolderPlus, X } from 'lucide-react';
import { getAcpControlClient } from '../../acp/acpConnection';
import { defineMessages, useIntl } from '../../i18n';
import { PROJECT_ALIAS_MAX_LENGTH } from '../../utils/projectAliases';
import { getProjectLabel, projectPathIdentity } from '../../utils/projectSessions';
import { errorMessage } from '../../utils/conversionUtils';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';

export const projectEditorMessages = defineMessages({
  edit: { id: 'projectEditor.edit', defaultMessage: 'Edit project' },
  main: { id: 'projectEditor.main', defaultMessage: 'Primary folder' },
  linked: { id: 'projectEditor.linked', defaultMessage: 'Additional folders' },
  add: { id: 'projectEditor.add', defaultMessage: 'Add folder' },
  reference: { id: 'projectEditor.reference', defaultMessage: 'Reference only' },
  write: { id: 'projectEditor.write', defaultMessage: 'Allow editing' },
  remove: { id: 'projectEditor.remove', defaultMessage: 'Unlink {name}' },
  hint: { id: 'projectEditor.hint', defaultMessage: 'Changes apply to new chats. Existing chats keep their original folders and permissions. Unlinking never deletes files.' },
  note: { id: 'projectEditor.note', defaultMessage: 'Folder note (optional)' },
  protected: { id: 'projectEditor.protected', defaultMessage: 'Reference-only folders disable full access for new chats.' },
});

interface LinkedFolder { path: string; access: 'reference' | 'write'; note?: string }
interface FolderConfig { version: string; folders: LinkedFolder[] }

export function ProjectEditor({ cwd, name, onClose, onSaveName }: {
  cwd: string; name: string; onClose: () => void; onSaveName: (name: string) => void;
}) {
  const intl = useIntl();
  const t = intl.formatMessage;
  const [draft, setDraft] = useState(name);
  const [config, setConfig] = useState<FolderConfig>();
  const [folders, setFolders] = useState<LinkedFolder[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  useEffect(() => {
    let live = true;
    void getAcpControlClient().then(client => client.extMethod('_codebuddy/project-folders/get', { cwd }))
      .then(result => {
        if (!live) return;
        const value = result as unknown as FolderConfig;
        setConfig(value);
        setFolders(value.folders);
      }).catch(reason => { if (live) setError(errorMessage(reason)); });
    return () => { live = false; };
  }, [cwd]);

  async function add() {
    try {
      const result = await window.electron.directoryChooser(true);
      if (result.canceled) return;
      setFolders(previous => {
        const keys = new Set([cwd, ...previous.map(f => f.path)].map(projectPathIdentity));
        const next = [...previous];
        for (const path of result.filePaths) {
          const key = projectPathIdentity(path);
          if (!keys.has(key)) next.push({ path, access: 'reference' });
          keys.add(key);
        }
        return next;
      });
    } catch (reason) { setError(errorMessage(reason)); }
  }

  async function save() {
    if (!config || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      if (JSON.stringify(config.folders) !== JSON.stringify(folders)) {
        const client = await getAcpControlClient();
        const updated = await client.extMethod('_codebuddy/project-folders/save', { cwd, version: config.version, folders });
        setConfig(updated as unknown as FolderConfig);
      }
      onSaveName(draft);
      window.dispatchEvent(new Event('codebuddy-project-folders-changed'));
      onClose();
    } catch (reason) { setError(errorMessage(reason)); }
    finally { savingRef.current = false; setSaving(false); }
  }

  return <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}>
    <DialogContent className="max-h-[85vh] overflow-y-auto">
      <DialogHeader><DialogTitle>{t(projectEditorMessages.edit)}</DialogTitle>
        <DialogDescription>{t(projectEditorMessages.hint)}</DialogDescription></DialogHeader>
      <form className="grid gap-4" onSubmit={event => { event.preventDefault(); void save(); }}>
        <label className="grid gap-1 text-sm">{intl.formatMessage({ id: 'navigationPanel.projectName', defaultMessage: 'Project name' })}
          <input autoFocus disabled={saving} maxLength={PROJECT_ALIAS_MAX_LENGTH} className="rounded-lg border border-border-primary bg-background-primary px-3 py-2"
            value={draft} onChange={event => setDraft(event.target.value)} /></label>
        <div className="grid gap-1 text-sm"><span>{t(projectEditorMessages.main)}</span>
          <div className="flex items-center gap-2 rounded-lg bg-background-secondary p-2"><Folder className="size-4 shrink-0" />
            <span className="break-all">{cwd}</span></div></div>
        <div className="grid gap-2 text-sm"><span>{t(projectEditorMessages.linked)}</span>
          <div className="max-h-52 overflow-y-auto divide-y divide-border-primary">{folders.map(folder =>
            <div key={folder.path} className="flex items-center gap-2 py-2">
              <Folder className="size-4 shrink-0" />
              <span className="min-w-0 flex-1"><strong>{getProjectLabel(folder.path)}</strong><small className="block break-all text-text-secondary">{folder.path}</small>
                <input disabled={saving} maxLength={500} value={folder.note ?? ''} aria-label={`${t(projectEditorMessages.note)}: ${folder.path}`} placeholder={t(projectEditorMessages.note)} className="mt-2 w-full rounded-md border border-border-primary bg-background-primary p-2 text-xs"
                  onChange={event => setFolders(folders.map(f => f === folder ? { ...f, note: event.target.value } : f))} />
              </span>
              <select disabled={saving} className="rounded-md border border-border-primary bg-background-primary p-1" aria-label={folder.path} value={folder.access}
                onChange={event => setFolders(folders.map(f => f === folder ? { ...f, access: event.target.value as LinkedFolder['access'] } : f))}>
                <option value="reference">{t(projectEditorMessages.reference)}</option><option value="write">{t(projectEditorMessages.write)}</option>
              </select>
              <button type="button" disabled={saving} aria-label={t(projectEditorMessages.remove, { name: folder.path })}
                onClick={() => setFolders(folders.filter(f => f !== folder))}><X className="size-4" /></button>
            </div>)}</div>
          <Button type="button" variant="outline" className="justify-self-start" disabled={!config || saving} onClick={() => void add()}>
            <FolderPlus className="size-4" />{t(projectEditorMessages.add)}</Button></div>
        {error && <p role="alert" className="text-sm text-text-primary">{error}</p>}
        {folders.some(folder => folder.access === 'reference') && <p className="text-xs text-text-secondary">{t(projectEditorMessages.protected)}</p>}
        <DialogFooter><Button type="button" variant="outline" disabled={saving} onClick={onClose}>{t({ id: 'common.cancel', defaultMessage: 'Cancel' })}</Button>
          <Button type="submit" disabled={!config || saving}>{t({ id: 'sessions.save', defaultMessage: 'Save' })}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
