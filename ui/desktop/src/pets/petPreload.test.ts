import { expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  send: vi.fn(),
  expose: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: bridge.expose },
  ipcRenderer: { send: bridge.send, on: bridge.on, off: bridge.off },
  webUtils: {},
}));
import '../preload';

it('returns a disposer bound to the exact registered pet listener', () => {
  const api = bridge.expose.mock.calls.find(([name]) => name === 'electron')?.[1];
  const callback = vi.fn();
  const dispose = api.on('pet-send-message', callback);
  expect(bridge.on).toHaveBeenCalledWith('pet-send-message', callback);
  dispose();
  expect(bridge.off).toHaveBeenCalledWith('pet-send-message', callback);
});

it('delivers pet signals to the main process and limits the bridge to pet channels', () => {
  const api = bridge.expose.mock.calls.find(([name]) => name === 'electron')?.[1];
  for (const channel of ['pet-hit-test', 'pet-task', 'pet-read', 'pet-message-result']) {
    const payload = channel === 'pet-hit-test' ? true : { sessionId: 'real-session' };
    api.petSignal(channel, payload);
    expect(bridge.send).toHaveBeenLastCalledWith(channel, payload);
  }
  api.petSignal('restart-app', {});
  expect(bridge.send).toHaveBeenCalledTimes(4);
});
