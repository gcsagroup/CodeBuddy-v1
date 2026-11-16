import type { App, BrowserWindow } from 'electron';

// Keep the renderer alive when closing to tray: it owns live chat subscriptions.
export function registerTrayLifecycle(
  app: App, hasTray: () => boolean, platform: string,
  quitApproved: () => boolean, isLastWindow: () => boolean
) {
  app.on('window-all-closed', () => {
    if (!hasTray()) app.quit();
  });

  return (window: BrowserWindow) => {
    let endingSession = false;
    window.on('query-session-end', () => { endingSession = true; });
    window.on('session-end', () => { endingSession = true; });
    window.on('close', (event) => {
      if (quitApproved() || endingSession) return;
      if (platform === 'win32' && hasTray()) {
        event.preventDefault();
        window.hide();
      } else if (!hasTray() && isLastWindow()) {
        // Keep the user's last window alive until before-quit has decided.
        event.preventDefault();
        app.quit();
      }
    });
  };
}
