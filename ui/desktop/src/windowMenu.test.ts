import { beforeEach, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { registerWindowMenu } from './windowMenu';

const mock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  popup: vi.fn(({ callback }: { callback: () => void }) => callback()),
  window: { getContentSize: () => [800, 600], setTitleBarOverlay: vi.fn() },
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      mock.handlers.set(name, handler),
  },
  BrowserWindow: { fromWebContents: () => mock.window },
  Menu: {
    getApplicationMenu: () => ({
      items: [
        { label: '&File', visible: true, enabled: true, submenu: { popup: mock.popup } },
        { label: 'Hidden', visible: false, enabled: true, submenu: { popup: mock.popup } },
        { label: 'Disabled', visible: true, enabled: false, submenu: { popup: mock.popup } },
      ],
    }),
  },
}));
const frame = {};
const event = {
  sender: { mainFrame: frame, getZoomFactor: () => 1.25 },
  senderFrame: frame,
} as unknown as IpcMainInvokeEvent;
beforeEach(() => {
  vi.clearAllMocks();
  registerWindowMenu(() => true);
});

it('uses current native menu commands and scales popup coordinates with window zoom', async () => {
  expect(mock.handlers.get('window-menu-list')!(event)).toEqual([
    { index: 0, label: 'File', enabled: true },
    { index: 2, label: 'Disabled', enabled: false },
  ]);
  await mock.handlers.get('window-menu-open')!(event, 0, 10, 36);
  expect(mock.popup).toHaveBeenCalledWith(
    expect.objectContaining({ window: mock.window, x: 13, y: 45 })
  );
});
it('rejects subframes, non-application windows and invalid menu requests', async () => {
  for (const args of [
    [-1, 0, 0],
    [99, 0, 0],
    [1, 0, 0],
    [2, 0, 0],
    [0, NaN, 0],
    ['0', 0, 0],
  ]) {
    await mock.handlers.get('window-menu-open')!(event, ...args);
  }
  await mock.handlers.get('window-menu-open')!({ ...event, senderFrame: {} }, 0, 0, 0);
  registerWindowMenu(() => false);
  await mock.handlers.get('window-menu-open')!(event, 0, 0, 0);
  expect(mock.handlers.get('window-menu-list')!(event)).toEqual([]);
  expect(mock.popup).not.toHaveBeenCalled();
});
