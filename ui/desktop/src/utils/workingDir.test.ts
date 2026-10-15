import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chooseOrdinaryWorkingDir,
  getHostProcessWorkingDir,
  getInitialWorkingDir,
  runWithOrdinaryWorkingDir,
} from './workingDir';

describe('getInitialWorkingDir', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'appConfig');
  });

  it('starts unbound when the backend only has a process working directory', () => {
    Object.defineProperty(window, 'appConfig', {
      configurable: true,
      value: {
        get: (key: string) => (key === 'GOOSE_WORKING_DIR' ? 'C:\\Users\\jiangrui' : undefined),
      },
    });

    expect(getInitialWorkingDir()).toBe('');
  });

  it('preselects only an explicitly requested directory', () => {
    Object.defineProperty(window, 'appConfig', {
      configurable: true,
      value: {
        get: (key: string) => (key === 'REQUEST_DIR' ? 'D:\\ExplicitProject' : undefined),
      },
    });

    expect(getInitialWorkingDir()).toBe('D:\\ExplicitProject');
  });

  it('keeps the host process cwd separate from the selected workspace', () => {
    Object.defineProperty(window, 'appConfig', {
      configurable: true,
      value: {
        get: (key: string) => (key === 'GOOSE_WORKING_DIR' ? 'C:\\Users\\jiangrui' : undefined),
      },
    });

    expect(getInitialWorkingDir()).toBe('');
    expect(getHostProcessWorkingDir()).toBe('C:\\Users\\jiangrui');
  });
});

describe('chooseOrdinaryWorkingDir', () => {
  it('never substitutes the host process cwd for an unbound ordinary chat', async () => {
    window.electron.directoryChooser = vi.fn().mockResolvedValue({ canceled: true, filePaths: [] });
    await expect(chooseOrdinaryWorkingDir('')).resolves.toBeNull();
    expect(window.electron.directoryChooser).toHaveBeenCalledOnce();
  });

  it('keeps an explicit directory without opening a picker', async () => {
    window.electron.directoryChooser = vi.fn();
    await expect(chooseOrdinaryWorkingDir('D:\\Project')).resolves.toBe('D:\\Project');
    expect(window.electron.directoryChooser).not.toHaveBeenCalled();
  });
});

describe('runWithOrdinaryWorkingDir', () => {
  it('never invokes a session creator after cancelled explicit selection', async () => {
    window.electron.directoryChooser = vi.fn().mockResolvedValue({ canceled: true, filePaths: [] });
    const create = vi.fn();

    await expect(runWithOrdinaryWorkingDir('', create)).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('passes only the exact selected directory to ordinary session creation', async () => {
    window.electron.directoryChooser = vi
      .fn()
      .mockResolvedValue({ canceled: false, filePaths: ['D:\\ExplicitProject'] });
    const create = vi.fn().mockResolvedValue('session-1');

    await expect(runWithOrdinaryWorkingDir('', create)).resolves.toEqual({
      workingDir: 'D:\\ExplicitProject',
      value: 'session-1',
    });
    expect(create).toHaveBeenCalledWith('D:\\ExplicitProject');
  });
});
