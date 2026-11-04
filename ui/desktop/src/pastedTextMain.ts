import { app, BrowserWindow, ipcMain, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

// Only an explicit click creates a copy. The renderer supplies text, never a
// destination, command or extension. Editor changes do not alter the draft.
export function registerPastedTextOpen() {
  ipcMain.handle('open-pasted-text', async (event, text: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame)
      throw new Error('Pasted text requires the application main frame');
    if (
      typeof text !== 'string' ||
      !text.length ||
      Buffer.byteLength(text, 'utf8') > 32 * 1024 * 1024
    )
      throw new Error('Invalid pasted text or text exceeds 32 MiB');
    const directory = await fs.mkdtemp(path.join(app.getPath('temp'), 'codebuddy-pasted-text-'));
    const file = path.join(directory, 'pasted-text.txt');
    await fs.writeFile(file, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    // Keep the temporary copy available while its external editor is open.
    const error = await shell.openPath(file);
    return { opened: !error };
  });
}
