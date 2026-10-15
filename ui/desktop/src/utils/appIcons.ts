export function windowIconFileName(platform: typeof process.platform): string {
  if (platform === 'win32') return 'icon.ico';
  if (platform === 'darwin') return 'icon.icns';
  return 'icon.png';
}

export function trayIconFileName(platform: typeof process.platform): string {
  return platform === 'win32' ? 'icon.png' : 'iconTemplate.png';
}

export const trayTooltip = 'CodeBuddy';
