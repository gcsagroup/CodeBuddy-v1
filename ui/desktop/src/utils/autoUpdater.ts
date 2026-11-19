import { app, Menu, nativeImage, type MenuItemConstructorOptions, type Tray } from 'electron';
import * as path from 'node:path';

export function setAutoDownloadDisabled(_disabled: boolean) {
  /* Manual downloads only. */
}
export function getAutoDownloadDisabled() {
  return true;
}

interface TrayActions {
  translate: (english: string, simplified: string, traditional: string) => string;
  open: () => void;
  newWindow: () => void;
  settings: (section?: string) => void;
}

export function buildTrayMenu(actions: TrayActions, imageDir: string, hasUpdate = false) {
  const t = actions.translate;
  const icon = (file: string) => {
    if (process.platform !== 'win32') return undefined;
    const image = nativeImage.createFromPath(path.join(imageDir, file));
    return image.isEmpty() ? undefined : image.resize({ width: 16, height: 16 });
  };
  const items: MenuItemConstructorOptions[] = [
    { label: t('Open CodeBuddy', '打开 CodeBuddy', '開啟 CodeBuddy'), icon: icon('icon.png'), click: actions.open },
    { label: t('New window', '新建窗口', '新增視窗'), icon: icon('tray-new-window.png'), click: actions.newWindow },
    { type: 'separator' },
    { label: t('Settings', '设置', '設定'), icon: icon('tray-settings.png'), click: () => actions.settings() },
  ];
  if (hasUpdate) items.push({
    label: t('View update…', '查看更新…', '檢視更新…'),
    click: () => actions.settings('update'),
  });
  items.push({ type: 'separator' }, {
    label: t('Quit CodeBuddy', '退出 CodeBuddy', '結束 CodeBuddy'), icon: icon('tray-quit.png'), click: () => app.quit(),
  });
  return Menu.buildFromTemplate(items);
}

export function configureTray(tray: Tray, iconPath: string, actions: TrayActions) {
  if (process.platform === 'darwin') {
    const icon = nativeImage.createFromPath(iconPath);
    icon.setTemplateImage(true);
    tray.setImage(icon);
  }
  const refresh = () => tray.setContextMenu(buildTrayMenu(actions, path.dirname(iconPath)));
  refresh();
  return refresh;
}
