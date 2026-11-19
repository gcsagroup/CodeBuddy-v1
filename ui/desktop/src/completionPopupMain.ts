import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { markAuxiliaryWindow } from './pets/petMain';

import { completionPopupBounds } from './utils/completionReminder';

type Notice = { sessionId: string; title: string; body: string; messageId: string };
let previousPopup: Promise<void> = Promise.resolve();

// Serialize cards so a later completion cannot replace a reply being typed.
export function showCompletionPopup(owner: BrowserWindow, notice: Notice, locale: string, appUrl: URL) {
  const finished = previousPopup.then(() => new Promise<void>((resolve, reject) => {
    if (owner.isDestroyed()) return resolve();
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.min(380, area.width);
    const popup = new BrowserWindow({
      title: 'CodeBuddy · 任务完成', width, height: 160, show: false, frame: false,
      transparent: true, skipTaskbar: true, resizable: false, alwaysOnTop: true,
      minimizable: false, maximizable: false, fullscreenable: false,
      webPreferences: { preload: path.join(__dirname, 'completionPopupPreload.js'),
        sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    markAuxiliaryWindow(popup);
    const close = () => { if (!popup.isDestroyed()) popup.destroy(); };
    const fail = (error: unknown) => { reject(error); close(); };
    const loading = setTimeout(() => fail(new Error('Completion popup did not become ready')), 15000);
    owner.once('closed', close);
    popup.once('closed', () => {
      clearTimeout(loading);
      owner.off('closed', close);
      resolve();
    });
    const contents = popup.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => event.preventDefault());
    contents.once('render-process-gone', (_event, details) => fail(new Error(details.reason)));
    contents.ipc.handle('completion-read', () => ({ title: notice.title, body: notice.body, locale }));
    contents.ipc.handleOnce('completion-show', (_event, measured: number) => {
      popup.setBounds(completionPopupBounds(area, measured));
      popup.showInactive();
      clearTimeout(loading);
    });
    contents.ipc.once('completion-dismiss', close);
    const reveal = () => {
      if (owner.isMinimized()) owner.restore();
      owner.show();
      owner.focus();
    };
    contents.ipc.once('completion-open', () => {
      reveal();
      owner.webContents.send('pet-open-session', notice.sessionId);
      close();
    });
    contents.ipc.handleOnce('completion-reply', (_event, text: unknown) => {
      if (typeof text !== 'string' || !text.trim()) throw new Error('Empty reply');
      reveal();
      owner.webContents.send('task-completion-notice', { ...notice, reply: text.trim() });
      close();
    });
    void popup.loadURL(new URL('completion-popup.html', appUrl).href).catch(fail);
  }));
  previousPopup = finished.catch(() => {});
  return finished;
}
