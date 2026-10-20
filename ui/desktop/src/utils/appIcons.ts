export function windowIconFileName(platform: typeof process.platform): string {
  if (platform === 'win32') return 'icon.ico';
  if (platform === 'darwin') return 'icon.icns';
  return 'icon.png';
}

export function trayIconFileName(platform: typeof process.platform, hasUpdate = false): string {
  if (platform === 'win32') return hasUpdate ? 'iconUpdate.ico' : 'icon.ico';
  if (platform === 'darwin') {
    return hasUpdate ? 'iconTemplateUpdate.png' : 'iconTemplate.png';
  }
  return hasUpdate ? 'iconUpdate.png' : 'icon.png';
}

export const trayTooltip = 'CodeBuddy';

export function windowsAppUserModelId(packaged: boolean): string {
  // Match the shortcut ID created by the existing Squirrel package.
  return packaged ? 'com.squirrel.CodeBuddyHarness.CodeBuddy' : 'local.codebuddy.harness.preview';
}
