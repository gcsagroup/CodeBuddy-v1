import { contextBridge, ipcRenderer } from 'electron';

const bridge = {
  read: (): Promise<{ title: string; body: string; locale: string }> => ipcRenderer.invoke('completion-read'),
  show: (height: number): Promise<void> => ipcRenderer.invoke('completion-show', height),
  dismiss: () => ipcRenderer.send('completion-dismiss'),
  open: () => ipcRenderer.send('completion-open'),
  reply: (text: string): Promise<void> => ipcRenderer.invoke('completion-reply', text),
};
export type CompletionPopupBridge = typeof bridge;
contextBridge.exposeInMainWorld('completionPopup', bridge);
