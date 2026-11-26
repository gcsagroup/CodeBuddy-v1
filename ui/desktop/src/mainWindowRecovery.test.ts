import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ show: vi.fn(), error: vi.fn() }));
vi.mock('electron', () => ({ dialog: { showMessageBox: mocks.show } }));
vi.mock('./utils/logger', () => ({ default: { error: mocks.error } }));
import { registerMainWindowRecovery } from './mainWindowRecovery';

function fixture() {
  const window = Object.assign(new EventEmitter(), {
    webContents: new EventEmitter(),
    reload: vi.fn(),
    show: vi.fn(),
    loadURL: vi.fn().mockResolvedValue(undefined),
    isDestroyed: vi.fn(() => false),
  });
  registerMainWindowRecovery(window as unknown as BrowserWindow, (_en, zh) => zh);
  return window;
}
const flush = async () => {
  await Promise.resolve();
};
function pendingChoice() {
  let resolve!: (value: { response: number }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ response: number }>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const crash = (window: ReturnType<typeof fixture>, reason = 'killed') =>
  window.webContents.emit('render-process-gone', {}, { reason, exitCode: 1 });

beforeEach(() => vi.resetAllMocks());

it('offers one native recovery prompt and reloads only the existing window after an explicit choice', async () => {
  const choice = pendingChoice();
  mocks.show.mockReturnValue(choice.promise);
  const window = fixture();
  crash(window);
  crash(window);
  expect(mocks.show).toHaveBeenCalledTimes(1);
  expect(mocks.show.mock.calls[0][0]).toBe(window);
  expect(window.reload).not.toHaveBeenCalled();
  choice.resolve({ response: 0 });
  await flush();
  expect(window.reload).toHaveBeenCalledTimes(1);
});

it('keeps the window without resubmitting when the user defers recovery', async () => {
  mocks.show.mockResolvedValue({ response: 1 });
  const window = fixture();
  crash(window, 'oom');
  await flush();
  expect(mocks.show.mock.calls[0][1].message).toContain('内存不足');
  expect(window.reload).not.toHaveBeenCalled();
  expect(mocks.show).toHaveBeenCalledTimes(1);
});

it('refreshes the cause when reopening fails before the renderer finishes loading', async () => {
  mocks.show.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 });
  const window = fixture();
  crash(window, 'oom');
  await flush();
  expect(window.reload).toHaveBeenCalledTimes(1);
  crash(window, 'launch-failed');
  await flush();
  expect(mocks.show.mock.calls[1][1].message).toBe('聊天界面意外停止');
  expect(window.reload).toHaveBeenCalledTimes(1);
});

it('invalidates an older crash choice when a different exit arrives without stacking dialogs', async () => {
  const old = pendingChoice();
  mocks.show.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ response: 1 });
  const window = fixture();
  crash(window, 'oom');
  crash(window, 'launch-failed');
  expect(mocks.show).toHaveBeenCalledTimes(1);
  old.resolve({ response: 0 });
  await flush();
  await flush();
  expect(window.reload).not.toHaveBeenCalled();
  expect(mocks.show.mock.calls[1][1].message).toBe('聊天界面意外停止');
});

it('ignores an obsolete dialog after manual reload or a responsive window', async () => {
  const choice = pendingChoice();
  mocks.show.mockReturnValue(choice.promise);
  const window = fixture();
  crash(window);
  window.webContents.emit('did-finish-load');
  choice.resolve({ response: 0 });
  await flush();
  expect(window.reload).not.toHaveBeenCalled();
  const waiting = pendingChoice();
  mocks.show.mockReturnValue(waiting.promise);
  window.emit('unresponsive');
  window.emit('responsive');
  waiting.resolve({ response: 1 });
  await flush();
  expect(window.reload).not.toHaveBeenCalled();
});

it('offers recovery for a crash that supersedes an unresponsive window without stacking dialogs', async () => {
  const waiting = pendingChoice();
  mocks.show.mockReturnValueOnce(waiting.promise).mockResolvedValueOnce({ response: 0 });
  const window = fixture();
  window.emit('unresponsive');
  crash(window);
  expect(mocks.show).toHaveBeenCalledTimes(1);
  waiting.resolve({ response: 0 });
  await flush();
  await flush();
  expect(mocks.show).toHaveBeenCalledTimes(2);
  expect(window.reload).toHaveBeenCalledTimes(1);
});

it('does not touch a closed window or leak rejected dialog promises', async () => {
  const choice = pendingChoice();
  mocks.show.mockReturnValue(choice.promise);
  const window = fixture();
  crash(window);
  const contents = window.webContents;
  window.isDestroyed.mockReturnValue(true);
  Object.defineProperty(window, 'webContents', { get() { throw new Error('Object has been destroyed'); } });
  window.emit('closed');
  choice.reject(new Error('parent closed'));
  await flush();
  expect(window.reload).not.toHaveBeenCalled();
  expect(contents.listenerCount('render-process-gone')).toBe(0);
  expect(contents.listenerCount('did-fail-load')).toBe(0);
  expect(window.listenerCount('unresponsive')).toBe(0);
  expect(mocks.error).toHaveBeenCalledTimes(1); // The original crash only.
});

it('retries the failed initial page URL and reveals the hidden window', async () => {
  mocks.show.mockResolvedValue({ response: 0 });
  const window = fixture();
  window.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:5173/', true);
  await flush();
  expect(window.show).toHaveBeenCalledOnce();
  expect(mocks.show.mock.calls[0][1].message).toBe('桌面页面加载失败');
  expect(window.loadURL).toHaveBeenCalledWith('http://127.0.0.1:5173/');
  expect(window.reload).not.toHaveBeenCalled();
});

it('ignores cancelled navigation and failed subframes', async () => {
  const window = fixture();
  window.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'file:///index.html', true);
  window.webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///frame.html', false);
  await flush();
  expect(mocks.show).not.toHaveBeenCalled();
  expect(window.show).not.toHaveBeenCalled();
});

it('does not retry a failed page after a newer navigation completes', async () => {
  const choice = pendingChoice();
  mocks.show.mockReturnValue(choice.promise);
  const window = fixture();
  window.webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///index.html', true);
  window.webContents.emit('did-start-navigation', {}, 'file:///other.html', false, true);
  window.webContents.emit('did-finish-load');
  choice.resolve({ response: 0 });
  await flush();
  expect(window.loadURL).not.toHaveBeenCalled();
});

it('does not mistake Chromium error-page completion for successful recovery', async () => {
  const choice = pendingChoice();
  mocks.show.mockReturnValue(choice.promise);
  const window = fixture();
  window.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:5173/', true);
  window.webContents.emit('did-finish-load');
  choice.resolve({ response: 0 });
  await flush();
  expect(window.loadURL).toHaveBeenCalledWith('http://127.0.0.1:5173/');
});
