import type { App, BrowserWindow } from 'electron';

// Keep the renderer alive when closing to tray: it owns live chat subscriptions.
export function registerTrayLifecycle(app: App, hasTray: () => boolean, platform: string) {
  let quitting = false;
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => {
    if (!hasTray()) app.quit();
  });

  return (window: BrowserWindow) => {
    let endingSession = false;
    window.on('query-session-end', () => { endingSession = true; });
    window.on('session-end', () => { endingSession = true; });
    window.on('close', (event) => {
      if (platform !== 'win32' || quitting || endingSession || !hasTray()) return;
      event.preventDefault();
      window.hide();
    });
  };
}
