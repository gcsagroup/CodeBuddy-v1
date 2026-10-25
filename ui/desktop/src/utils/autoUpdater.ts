import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  type Tray,
  type MenuItemConstructorOptions,
} from 'electron';
import * as path from 'node:path';
import log from './logger';
import { trayIconFileName } from './appIcons';

// Tray presentation only. Product update execution lives in update/main.ts.
let trayRef: Tray | null = null;
const updateAvailable = false;
export function setAutoDownloadDisabled(_disabled: boolean) {
  /* Manual downloads only. */
}
export function getAutoDownloadDisabled() {
  return true;
}
function updateTrayIcon(hasUpdate: boolean) {
  if (!trayRef) return;

  if (process.env.GOOSE_VERSION) {
    hasUpdate = false;
  }

  const iconPath = path.join(
    app.isPackaged ? process.resourcesPath : path.join(process.cwd(), 'src'),
    'images',
    trayIconFileName(process.platform, hasUpdate)
  );
  trayRef.setToolTip(hasUpdate ? 'CodeBuddy - Update Available' : 'CodeBuddy');

  const icon = nativeImage.createFromPath(iconPath);
  if (process.platform === 'darwin') {
    // Mark as template for macOS to handle dark/light mode
    icon.setTemplateImage(true);
  }
  trayRef.setImage(icon);

  // Update tray menu when icon changes
  updateTrayMenu(hasUpdate);
}

// Function to open settings and scroll to update section
function openUpdateSettings() {
  const windows = BrowserWindow.getAllWindows();
  if (windows.length > 0) {
    const mainWindow = windows[0];
    mainWindow.show();
    mainWindow.focus();
    // Send message to open settings and scroll to update section
    mainWindow.webContents.send('set-view', 'settings', 'update');
  }
}

// Export function to update tray menu
export function updateTrayMenu(hasUpdate: boolean) {
  if (!trayRef) return;

  const menuItems: MenuItemConstructorOptions[] = [];

  // Add update menu item if update is available
  if (hasUpdate) {
    menuItems.push({
      label: 'Update Available...',
      click: openUpdateSettings,
    });
  }

  menuItems.push(
    {
      label: 'Show Window',
      click: async () => {
        const windows = BrowserWindow.getAllWindows();
        if (windows.length === 0) {
          log.info('No windows are open, creating a new one...');
          // Emit event to create new window (handled in main.ts)
          ipcMain.emit('create-chat-window', {}, undefined);
          return;
        }

        // Show all windows with offset
        const initialOffsetX = 30;
        const initialOffsetY = 30;

        windows.forEach((win: BrowserWindow, index: number) => {
          const currentBounds = win.getBounds();
          const newX = currentBounds.x + initialOffsetX * index;
          const newY = currentBounds.y + initialOffsetY * index;

          win.setBounds({
            x: newX,
            y: newY,
            width: currentBounds.width,
            height: currentBounds.height,
          });

          if (!win.isVisible()) {
            win.show();
          }

          win.focus();
        });
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  );

  const contextMenu = Menu.buildFromTemplate(menuItems);
  trayRef.setContextMenu(contextMenu);
}

// Export functions to manage tray reference
export function setTrayRef(tray: Tray) {
  trayRef = tray;
  // Update icon based on current update status
  updateTrayIcon(updateAvailable);
}

export function getUpdateAvailable(): boolean {
  return updateAvailable;
}
