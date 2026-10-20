import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, truncate, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  configureElectronProfile,
  profilePartition,
  maintainElectronCache,
  HTTP_CACHE_BYTES,
  CODE_CACHE_BYTES,
} from './electronProfile';
import { resolveCodeBuddyPaths } from './codeBuddyPaths';

const paths = resolveCodeBuddyPaths({
  platform: 'win32',
  userHome: String.raw`C:\Users\tester`,
  codeBuddyHome: String.raw`D:\isolated\.CodeBuddy`,
});

function fakeElectronApp(ready: boolean) {
  return {
    isReady: vi.fn(() => ready),
    setPath: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
  };
}

describe('configureElectronProfile', () => {
  it('sets device and profile paths before ready', () => {
    const app = fakeElectronApp(false);

    configureElectronProfile(app, paths);

    expect(app.setPath).toHaveBeenNthCalledWith(1, 'userData', paths.electronUserDataDir);
    expect(app.setPath).toHaveBeenNthCalledWith(2, 'sessionData', paths.electronSessionDataDir);
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith(
      'disk-cache-size',
      String(HTTP_CACHE_BYTES)
    );
  });

  it('rejects configuration after ready without changing a path', () => {
    const app = fakeElectronApp(true);

    expect(() => configureElectronProfile(app, paths)).toThrow(
      'Electron storage paths must be configured before app ready'
    );
    expect(app.setPath).not.toHaveBeenCalled();
  });
});

describe('bounded browser caches', () => {
  it('clears oversized caches through Electron without clearing persistent storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codebuddy-cache-'));
    try {
      await mkdir(join(root, 'Code Cache'));
      const file = join(root, 'Code Cache', 'compiled-script');
      await writeFile(file, '');
      await truncate(file, CODE_CACHE_BYTES + 1);
      const target = {
        storagePath: root,
        getCacheSize: vi.fn(async () => HTTP_CACHE_BYTES + 1),
        clearCache: vi.fn(),
        clearCodeCaches: vi.fn(),
        clearStorageData: vi.fn(),
      };
      await maintainElectronCache(target);
      expect(target.clearCache).toHaveBeenCalledOnce();
      expect(target.clearCodeCaches).toHaveBeenCalledWith({});
      expect(target.clearStorageData).not.toHaveBeenCalled();
      await truncate(file, CODE_CACHE_BYTES);
      target.getCacheSize.mockResolvedValue(HTTP_CACHE_BYTES);
      vi.clearAllMocks();
      await maintainElectronCache(target);
      expect(target.clearCache).not.toHaveBeenCalled();
      expect(target.clearCodeCaches).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('profilePartition', () => {
  it('returns one stable persistent partition for the local profile', () => {
    expect(profilePartition('local')).toBe('persist:profile-local');
  });

  it('rejects unsupported or unsafe profile identifiers', () => {
    expect(() => profilePartition('other')).toThrow('Only the local profile is supported');
    expect(() => profilePartition('../local')).toThrow('Only the local profile is supported');
  });
});
