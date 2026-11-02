import type { BrowserWindow } from 'electron';

// Focus is not visibility: the control overlay never focuses, and the chat can
// remain visible while another app receives input. Keep those frames updating,
// but let Chromium throttle hidden/minimized windows again.
export function maintainVisibleWindowFrames(window: BrowserWindow) {
  const sync = () => {
    if (window.isDestroyed()) return;
    window.webContents.setBackgroundThrottling(!window.isVisible() || window.isMinimized());
  };
  window.on('show', sync);
  window.on('hide', sync);
  window.on('minimize', sync);
  window.on('restore', sync);
  sync();
}
