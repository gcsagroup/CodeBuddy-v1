import fs from 'node:fs';
import path from 'node:path';
import type { Shell, ShortcutDetails } from 'electron';
import { windowsAppUserModelId } from './appIcons';

export const previewToastActivator = '{45B4ED33-C00E-4A23-A251-0B536E1819F8}';

// Windows reads the notification sender's label and icon from its Start menu identity.
export function registerPreviewShortcut(
  shell: Pick<Shell, 'readShortcutLink' | 'writeShortcutLink'>,
  appData: string, desktopDir: string, electronExe: string
): boolean {
  const repo = path.resolve(desktopDir, '../..');
  const launcher = path.join(repo, 'start-preview.ps1');
  const icon = path.join(desktopDir, 'src/images/icon.ico');
  if (!fs.existsSync(launcher) || !fs.existsSync(icon)) return false;
  const programs = path.join(appData, 'Microsoft/Windows/Start Menu/Programs');
  const shortcut = path.join(programs, 'CodeBuddy Preview', 'CodeBuddy.lnk');
  const legacy = path.join(programs, 'Electron.lnk');
  const id = windowsAppUserModelId(false);
  const details: ShortcutDetails = {
    target: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    args: '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + launcher + '"',
    cwd: repo, description: 'CodeBuddy', appUserModelId: id, toastActivatorClsid: previewToastActivator, icon, iconIndex: 0,
  };
  fs.mkdirSync(path.dirname(shortcut), { recursive: true });
  if (fs.existsSync(shortcut) && shell.readShortcutLink(shortcut).appUserModelId !== id)
    throw new Error('Preview shortcut path belongs to another application');
  let migrated = false;
  if (fs.existsSync(legacy)) {
    const previous = shell.readShortcutLink(legacy);
    if (previous.appUserModelId === id && previous.target.toLowerCase() === electronExe.toLowerCase()) {
      fs.renameSync(legacy, shortcut);
      migrated = true;
    }
  }
  const exists = fs.existsSync(shortcut);
  if (exists) {
    const previous = shell.readShortcutLink(shortcut);
    if (previous.target === details.target && previous.args === details.args &&
        previous.icon === icon && previous.iconIndex === 0 && previous.cwd === repo &&
        previous.toastActivatorClsid?.toLowerCase() === previewToastActivator.toLowerCase()) return migrated;
  }
  if (!shell.writeShortcutLink(shortcut, exists ? 'update' : 'create', details)) {
    throw new Error('Windows could not write the preview shortcut');
  }
  return migrated;
}
