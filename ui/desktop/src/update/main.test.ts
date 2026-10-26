import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => ({
  install: undefined as undefined | (() => Promise<void | false>),
  dialog: vi.fn(), stop: vi.fn(), reserve: vi.fn(), release: vi.fn(),
  prepare: vi.fn(), commit: vi.fn(), cancel: vi.fn(), stage: vi.fn(), macInstall: vi.fn(),
  quit: vi.fn(), relaunch: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => 'fixture', getVersion: () => '1.0.0', getLocale: () => 'zh-CN', on: vi.fn(), quit: hooks.quit, relaunch: hooks.relaunch },
  autoUpdater: { on: vi.fn() }, BrowserWindow: { getAllWindows: () => [] },
  dialog: { showMessageBox: hooks.dialog }, ipcMain: { handle: vi.fn() },
}));
vi.mock('node:fs/promises', () => {
  const methods = { mkdir: async () => {}, writeFile: async () => {} };
  return { ...methods, default: methods };
});
vi.mock('../github/githubCliAuth', () => ({ githubUpdateCredential: vi.fn() }));
vi.mock('../utils/logger', () => ({ default: { warn: vi.fn() } }));
vi.mock('./githubRelease', () => ({ GitHubReleaseSource: class {} }));
vi.mock('./controller', () => ({ UpdateController: class {
  constructor(options: { install: () => Promise<void | false> }) { hooks.install = options.install; }
} }));
vi.mock('./nativeInstall', () => ({
  previousInstallError: () => undefined,
  prepareWindowsInstall: hooks.prepare,
  MacUpdateInstaller: class { stage = hooks.stage; install = hooks.macInstall; },
}));
import { registerProductUpdates } from './main';
const platform = process.platform;
beforeEach(() => {
  vi.resetAllMocks();
  hooks.dialog.mockResolvedValue({ response: 1 });
  hooks.stop.mockResolvedValue(undefined);
  hooks.reserve.mockReturnValue(hooks.release);
  hooks.prepare.mockResolvedValue({ commit: hooks.commit, cancel: hooks.cancel });
  registerProductUpdates({ closeForUpdate: hooks.stop, hasTerminals: () => true, reserveTerminals: hooks.reserve });
});
afterEach(() => Object.defineProperty(process, 'platform', { value: platform }));
for (const target of ['win32', 'darwin']) {
  it(`${target}: Later leaves tasks/terminals untouched; confirmed update waits for saving`, async () => {
    Object.defineProperty(process, 'platform', { value: target });
    hooks.dialog.mockResolvedValueOnce({ response: 0 });
    expect(await hooks.install!()).toBe(false);
    expect(hooks.stop).not.toHaveBeenCalled();
    expect(hooks.reserve).not.toHaveBeenCalled();
    expect(hooks.dialog.mock.calls[0][0]).toMatchObject({ defaultId: 0, cancelId: 0 });
    expect(hooks.dialog.mock.calls[0][0].detail).toContain('当前有打开的终端');
    let saved!: () => void;
    hooks.stop.mockReturnValueOnce(new Promise<void>(resolve => { saved = resolve; }));
    const installing = hooks.install!();
    await vi.waitFor(() => expect(hooks.stop).toHaveBeenCalledOnce());
    expect(hooks.prepare).not.toHaveBeenCalled();
    expect(hooks.stage).not.toHaveBeenCalled();
    saved();
    await installing;
    expect(target === 'win32' ? hooks.commit : hooks.macInstall).toHaveBeenCalledOnce();
  });
  it(`${target}: saving failure never hands the package to an installer`, async () => {
    Object.defineProperty(process, 'platform', { value: target });
    hooks.stop.mockRejectedValueOnce(new Error('save failed'));
    await expect(hooks.install!()).rejects.toThrow('save failed');
    expect(hooks.prepare).not.toHaveBeenCalled();
    expect(hooks.stage).not.toHaveBeenCalled();
    expect(hooks.quit).not.toHaveBeenCalled();
    expect(hooks.release).toHaveBeenCalledOnce();
  });
}
