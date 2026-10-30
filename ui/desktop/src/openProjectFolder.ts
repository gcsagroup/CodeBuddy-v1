import { realpath, stat } from 'node:fs/promises';
import type { BrowserWindow } from 'electron';

// Selecting a project only stages a draft in the originating window. Session
// creation and workspace permission checks still happen through the Send path.
export async function openProjectFolderInWindow(
  window: BrowserWindow,
  directory: string,
  confirm: (directory: string) => Promise<boolean>
): Promise<string | undefined> {
  if (window.isDestroyed()) return;
  const canonical = await realpath(directory);
  if (!(await stat(canonical)).isDirectory()) throw new Error('Select an existing folder');
  if (!(await confirm(canonical)) || window.isDestroyed()) return;
  window.webContents.send('new-chat', canonical);
  window.show();
  window.focus();
  return canonical;
}
