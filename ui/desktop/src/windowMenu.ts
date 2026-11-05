import { BrowserWindow, ipcMain, Menu, type IpcMainInvokeEvent } from 'electron';

/** The renderer only chooses an existing native menu; it never supplies commands. */
export function registerWindowMenu(isApplicationWindow: (window: BrowserWindow) => boolean) {
  const windowFor = (event: IpcMainInvokeEvent) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return window && event.senderFrame === event.sender.mainFrame && isApplicationWindow(window)
      ? window
      : null;
  };
  ipcMain.handle('window-menu-list', (event) => {
    if (!windowFor(event)) return [];
    return (Menu.getApplicationMenu()?.items ?? []).flatMap((item, index) =>
      item.visible && item.submenu
        ? [{ index, label: item.label.replace(/&/g, ''), enabled: item.enabled }]
        : []
    );
  });
  ipcMain.handle('window-menu-open', async (event, index: unknown, x: unknown, y: unknown) => {
    const window = windowFor(event);
    if (!window || !Number.isInteger(index) || typeof index !== 'number' || index < 0) return;
    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    )
      return;
    const item = Menu.getApplicationMenu()?.items[index];
    if (!item?.visible || !item.enabled || !item.submenu) return;
    const [width, height] = window.getContentSize();
    const zoom = event.sender.getZoomFactor();
    await new Promise<void>((resolve) =>
      item.submenu!.popup({
        window,
        x: Math.round(Math.max(0, Math.min(width, x * zoom))),
        y: Math.round(Math.max(0, Math.min(height, y * zoom))),
        callback: resolve,
      })
    );
  });
  ipcMain.handle('window-titlebar-theme', (event, theme: unknown) => {
    const window = windowFor(event);
    if (process.platform !== 'win32' || !window || (theme !== 'light' && theme !== 'dark')) return;
    window.setTitleBarOverlay({
      color: theme === 'dark' ? '#202329' : '#f6f7f9',
      symbolColor: theme === 'dark' ? '#e2e5eb' : '#505867',
      height: 36,
    });
  });
}
