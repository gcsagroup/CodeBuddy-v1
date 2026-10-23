import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ show: vi.fn(), plan: vi.fn(), spawn: vi.fn(), quit: vi.fn() }));
vi.mock('electron', () => ({ app: { isPackaged: true, quit: mocks.quit }, dialog: { showMessageBox: mocks.show } }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn, default: { spawn: mocks.spawn } }));
vi.mock('../../../../runtime/macos-uninstall.cjs', () => ({ createPlan: mocks.plan }));
import { showMacUninstall } from './macosUninstall';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const resources = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
const options = { dataRoot: '/Users/fixture/.CodeBuddy', workspace: '/Users/fixture/.CodeBuddy/workspaces',
  t: (_english: string, simplified: string) => simplified };
describe('Mac native uninstall confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    Object.defineProperty(process, 'resourcesPath', { value: '/Applications/CodeBuddy.app/Contents/Resources', configurable: true });
    mocks.plan.mockResolvedValue({ bytes: 128, targets: [{ path: '/Applications/CodeBuddy.app' }], preserved: [options.workspace] });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    if (resources) Object.defineProperty(process, 'resourcesPath', resources);
    else Reflect.deleteProperty(process, 'resourcesPath');
  });
  it('defaults to preserve data and cancellation never starts a worker', async () => {
    mocks.show.mockResolvedValueOnce({ response: 2 });
    await showMacUninstall(options);
    expect(mocks.show.mock.calls[0][0]).toMatchObject({ defaultId: 0, cancelId: 2 });
    expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.quit).not.toHaveBeenCalled();
  });
  it('ordinary uninstall reviews application removal and can cancel before side effects', async () => {
    mocks.show.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 0 });
    await showMacUninstall(options);
    expect(mocks.plan).toHaveBeenCalledWith(expect.objectContaining({ cleanData: false, deleteProjects: false }));
    expect(mocks.show.mock.calls[1][0]).toMatchObject({ defaultId: 0, cancelId: 0 });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it('cleanup requires a separate explicit project checkbox, unchecked by default', async () => {
    mocks.show.mockResolvedValueOnce({ response: 1 }).mockResolvedValueOnce({ response: 0, checkboxChecked: false }).mockResolvedValueOnce({ response: 0 });
    await showMacUninstall(options);
    expect(mocks.show.mock.calls[1][0]).toMatchObject({ checkboxChecked: false });
    expect(mocks.plan).toHaveBeenCalledWith(expect.objectContaining({ cleanData: true, deleteProjects: false }));
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it('passes only the explicit project choice and still requires final confirmation', async () => {
    mocks.show.mockResolvedValueOnce({ response: 1 }).mockResolvedValueOnce({ response: 0, checkboxChecked: true }).mockResolvedValueOnce({ response: 0 });
    await showMacUninstall(options);
    expect(mocks.plan).toHaveBeenCalledWith(expect.objectContaining({ cleanData: true, deleteProjects: true }));
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it('does not expose a Windows uninstall path', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    await showMacUninstall(options);
    expect(mocks.show).not.toHaveBeenCalled();
  });
});
