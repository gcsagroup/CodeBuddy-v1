import type { BrowserWindow } from 'electron';

export function revealChatOnActivate(windows: BrowserWindow[]) {
  const target = windows.find((window) => window.isFocused())
    ?? windows.find((window) => window.isVisible() && !window.isMinimized())
    ?? windows[0];
  if (!target) return;
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
}
