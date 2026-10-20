import { expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  send: vi.fn(),
  expose: vi.fn(),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: bridge.expose },
  ipcRenderer: { send: bridge.send },
  webUtils: {},
}));
import '../preload';

it('delivers pet signals to the main process and limits the bridge to pet channels', () => {
  const api = bridge.expose.mock.calls.find(([name]) => name === 'electron')?.[1];
  for (const channel of ['pet-hit-test', 'pet-task', 'pet-read']) {
    const payload = channel === 'pet-hit-test' ? true : { sessionId: 'real-session' };
    api.petSignal(channel, payload);
    expect(bridge.send).toHaveBeenLastCalledWith(channel, payload);
  }
  api.petSignal('restart-app', {});
  expect(bridge.send).toHaveBeenCalledTimes(3);
});
