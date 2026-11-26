import { useRef, useState } from 'react';
import { Folder, FolderPlus, X } from 'lucide-react';
import { getAcpControlClient } from '../../acp/acpConnection';
import { defineMessages, useIntl } from '../../i18n';
import { getProjectLabel, projectPathIdentity } from '../../utils/projectSessions';
import { saveProjectAlias, PROJECT_ALIAS_MAX_LENGTH } from '../../utils/projectAliases';
import { setSidebarProjectVisible } from '../../utils/sidebarProjects';
import { errorMessage } from '../../utils/conversionUtils';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { projectEditorMessages } from './ProjectEditor';

const messages = defineMessages({
  folders: { id: 'projectCreator.folders', defaultMessage: 'Project folders' },
  title: { id: 'projectCreator.title', defaultMessage: 'Create workspace' },
  hint: { id: 'projectCreator.hint', defaultMessage: 'Choose a primary folder and related folders. New chats start in the primary folder.' },
  primary: { id: 'projectCreator.makePrimary', defaultMessage: 'Make primary' },
  note: { id: 'projectCreator.note', defaultMessage: 'Optional note, for example: upstream source or documentation' },
  protected: { id: 'projectCreator.protected', defaultMessage: 'Reference-only folders are protected from edits. Full access is unavailable while they are attached.' },
  existing: { id: 'projectCreator.existing', defaultMessage: 'This folder already has a workspace configuration. Open Edit project to change it.' },
});
type FolderEntry = { path: string; access: 'reference' | 'write'; note: string };

export function ProjectCreator({ onClose, onCreated }: { onClose: () => void; onCreated: (cwd: string) => void | Promise<void> }) {
  const intl = useIntl();
  const t = intl.formatMessage;
  const [name, setName] = useState('');
  const nameEdited = useRef(false);
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState('');
  const saveInFlight = useRef(false);
  const chooseInFlight = useRef(false);
  const savedConfig = useRef<{ cwd: string; folders: string } | undefined>(undefined);
  async function add() {
    if (chooseInFlight.current) return;
    chooseInFlight.current = true; setChoosing(true); setError('');
    try {
      const result = await window.electron.directoryChooser(true);
      if (result.canceled) return;
      const next = [...folders];
      const keys = new Set(next.map(f => projectPathIdentity(f.path)));
      for (const path of result.filePaths) {
        if (!keys.has(projectPathIdentity(path))) next.push({ path, access: 'write', note: '' });
        keys.add(projectPathIdentity(path));
      }
      setFolders(next);
      if (!nameEdited.current && next.length) setName(getProjectLabel(next[0].path));
    } catch (reason) { setError(errorMessage(reason)); }
    finally { chooseInFlight.current = false; setChoosing(false); }
  }
  async function save() {
    if (saveInFlight.current || !folders.length || !name.trim()) return;
    saveInFlight.current = true; setBusy(true); setError('');
    try {
      const cwd = folders[0].path;
      const client = await getAcpControlClient();
      const current = await client.extMethod('_codebuddy/project-folders/get', { cwd }) as { version: string };
      const contents = JSON.stringify(folders.slice(1));
      if (current.version && savedConfig.current?.cwd !== cwd) throw new Error(t(messages.existing));
      if (!savedConfig.current || savedConfig.current.folders !== contents) {
        await client.extMethod('_codebuddy/project-folders/save', { cwd, version: current.version, folders: folders.slice(1) });
        savedConfig.current = { cwd, folders: contents };
      }
      saveProjectAlias(cwd, name.trim(), getProjectLabel(cwd));
      setSidebarProjectVisible(cwd, true);
      window.electron.addRecentDir(cwd);
      window.dispatchEvent(new Event('codebuddy-project-folders-changed'));
      await onCreated(cwd);
      onClose();
    } catch (reason) { setError(errorMessage(reason)); }
    finally { saveInFlight.current = false; setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy && !choosing) onClose(); }}>
    <DialogContent overlayClassName="bg-black/25 backdrop-blur-[2px]" className="sm:max-w-[600px] max-h-[85vh] overflow-y-auto rounded-3xl border-border-primary p-7 shadow-2xl sm:p-8" onInteractOutside={event => { if (choosing || busy) event.preventDefault(); }}>
      <DialogHeader className="mb-2 gap-3 pr-8 text-left"><DialogTitle className="text-2xl font-semibold tracking-tight leading-8">{t(messages.title)}</DialogTitle><DialogDescription className="text-sm leading-6">{t(messages.hint)}</DialogDescription></DialogHeader>
      <form className="grid gap-6" onSubmit={event => { event.preventDefault(); void save(); }}>
        <label className="grid gap-2.5 text-sm font-medium">{t({ id: 'navigationPanel.projectName', defaultMessage: 'Project name' })}
          <div className="flex items-center overflow-hidden rounded-xl border border-border-primary bg-background-primary transition-shadow focus-within:border-text-secondary focus-within:ring-2 focus-within:ring-border-primary"><span className="flex h-12 w-12 shrink-0 items-center justify-center border-r border-border-primary text-text-secondary"><Folder className="size-5" aria-hidden="true" /></span><input placeholder={t({ id: 'navigationPanel.projectName', defaultMessage: 'Project name' })} autoFocus disabled={busy} maxLength={PROJECT_ALIAS_MAX_LENGTH} className="h-12 min-w-0 flex-1 bg-transparent px-4 text-sm font-normal outline-none placeholder:text-text-secondary/60"
            value={name} onChange={event => { nameEdited.current = true; setName(event.target.value); }} /></div>
        </label>
        <section className="grid gap-2.5" aria-label={t(messages.folders)}><div className="flex items-center justify-between text-sm font-medium"><span>{t(messages.folders)}</span>{folders.length > 0 && <span className="rounded-full bg-background-secondary px-2 text-xs leading-5 text-text-secondary">{folders.length}</span>}</div><div className="overflow-hidden rounded-2xl border border-border-primary">
          <div className="max-h-80 overflow-y-auto divide-y divide-border-primary">{folders.map((folder, index) => <div key={folder.path} className="grid gap-3 p-4">
            <div className="flex items-start gap-2">
              <Folder className="mt-0.5 size-5 shrink-0 text-text-secondary" />
              <div className="min-w-0 flex-1"><strong className="block truncate text-sm font-medium">{getProjectLabel(folder.path)}</strong><div className="mt-1 text-xs leading-5 text-text-secondary [overflow-wrap:anywhere]">{folder.path}</div></div>
              {index === 0 ? <span className="shrink-0 rounded-full bg-background-secondary px-2.5 py-1 text-xs text-text-secondary">{t(projectEditorMessages.main)}</span> :
                <button type="button" disabled={busy || choosing} className="shrink-0 rounded-full border border-border-primary px-2.5 py-1 text-xs text-text-secondary hover:bg-background-secondary" onClick={() => {
                  setFolders([folder, ...folders.filter(f => f !== folder)]);
                  if (!nameEdited.current) setName(getProjectLabel(folder.path));
                }}>{t(messages.primary)}</button>}
              <button type="button" disabled={busy || choosing} className="rounded-md p-1 hover:bg-background-secondary" aria-label={t(projectEditorMessages.remove, { name: folder.path })} onClick={() => {
                const next = folders.filter(f => f !== folder); setFolders(next);
                if (!nameEdited.current) setName(next.length ? getProjectLabel(next[0].path) : '');
              }}><X className="size-4" /></button>
            </div>
            {index > 0 && <div className="ml-7 grid gap-2 sm:grid-cols-[1fr_auto]">
              <input disabled={busy} maxLength={500} value={folder.note} aria-label={`${t(messages.note)}: ${folder.path}`} placeholder={t(messages.note)} className="min-w-0 rounded-lg border border-border-primary bg-background-primary px-3 py-2.5 text-xs"
                onChange={event => setFolders(folders.map(f => f === folder ? { ...f, note: event.target.value } : f))} />
              <select disabled={busy} aria-label={folder.path} value={folder.access} className="rounded-lg border border-border-primary bg-background-primary px-3 py-2.5 text-xs"
                onChange={event => setFolders(folders.map(f => f === folder ? { ...f, access: event.target.value as FolderEntry['access'] } : f))}>
                <option value="write">{t(projectEditorMessages.write)}</option><option value="reference">{t(projectEditorMessages.reference)}</option>
              </select>
            </div>}
          </div>)}</div>
          <Button type="button" variant="ghost" className={folders.length ? "h-12 w-full justify-start gap-3 rounded-none px-4 text-text-secondary hover:text-text-primary" : "h-36 w-full flex-col justify-center gap-3 rounded-none bg-background-secondary/30 text-text-secondary hover:bg-background-secondary/60 hover:text-text-primary"} disabled={busy || choosing} onClick={() => void add()}><span className={folders.length ? "" : "flex size-11 items-center justify-center rounded-xl border border-border-primary bg-background-primary shadow-sm"}><FolderPlus className="size-5" /></span><span className="text-sm font-medium">{t(projectEditorMessages.add)}</span></Button>
        </div></section>
        {folders.slice(1).some(f => f.access === 'reference') && <p className="text-xs text-text-secondary">{t(messages.protected)}</p>}
        {error && <p role="alert" className="text-sm text-text-primary">{error}</p>}
        <DialogFooter className="gap-3 pt-2"><Button className="h-10 rounded-xl px-5" type="button" variant="ghost" disabled={busy || choosing} onClick={onClose}>{t({ id: 'common.cancel', defaultMessage: 'Cancel' })}</Button>
          <Button className="h-10 rounded-xl px-6 font-medium" type="submit" disabled={busy || choosing || !folders.length || !name.trim()}>{t(messages.title)}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
