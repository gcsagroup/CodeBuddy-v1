import type { MenuItemConstructorOptions, Tray } from 'electron';
import { expect, it, vi } from 'vitest';
import { app, Menu } from 'electron';
import { buildTrayMenu, configureTray } from './autoUpdater';

vi.mock('electron', () => ({
  app: { quit: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  nativeImage: { createFromPath: () => ({ isEmpty: () => false, resize: vi.fn(), setTemplateImage: vi.fn() }) },
}));

it('groups window commands before settings and quit, and dispatches each command once', () => {
  const actions = {
    translate: (_en: string, zh: string) => zh,
    open: vi.fn(), newWindow: vi.fn(), settings: vi.fn(),
  };
  buildTrayMenu(actions, '.');
  const items = vi.mocked(Menu.buildFromTemplate).mock.lastCall![0] as MenuItemConstructorOptions[];
  expect(items.map(item => item.label ?? item.type)).toEqual([
    '打开 CodeBuddy', '新建窗口', 'separator', '设置', 'separator', '退出 CodeBuddy',
  ]);
  for (const item of items) if (item.click) Reflect.apply(item.click, item, []);
  expect(actions.open).toHaveBeenCalledOnce();
  expect(actions.newWindow).toHaveBeenCalledOnce();
  expect(actions.settings.mock.calls).toEqual([[]]);
  expect(app.quit).toHaveBeenCalledOnce();
});

it('picks up a language change and keeps update navigation distinct from ordinary settings', () => {
  let chinese = false;
  const actions = { translate: (en: string, zh: string) => chinese ? zh : en,
    open: vi.fn(), newWindow: vi.fn(), settings: vi.fn() };
  const tray = { setContextMenu: vi.fn(), setImage: vi.fn() };
  const refresh = configureTray(tray as unknown as Tray, 'icon.png', actions);
  expect(vi.mocked(Menu.buildFromTemplate).mock.lastCall![0][0].label).toBe('Open CodeBuddy');
  chinese = true;
  refresh();
  expect(vi.mocked(Menu.buildFromTemplate).mock.lastCall![0][0].label).toBe('打开 CodeBuddy');
  expect(tray.setContextMenu).toHaveBeenCalledTimes(2);
  buildTrayMenu(actions, '.', true);
  const update = vi.mocked(Menu.buildFromTemplate).mock.lastCall![0].find(i => i.label === '查看更新…');
  Reflect.apply(update!.click!, update, []);
  expect(actions.settings).toHaveBeenCalledWith('update');
});
