import { describe, expect, it, vi } from 'vitest';

import { configureElectronProfile, profilePartition } from './electronProfile';
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
  };
}

describe('configureElectronProfile', () => {
  it('sets device and profile paths before ready', () => {
    const app = fakeElectronApp(false);

    configureElectronProfile(app, paths);

    expect(app.setPath).toHaveBeenNthCalledWith(1, 'userData', paths.electronUserDataDir);
    expect(app.setPath).toHaveBeenNthCalledWith(2, 'sessionData', paths.electronSessionDataDir);
  });

  it('rejects configuration after ready without changing a path', () => {
    const app = fakeElectronApp(true);

    expect(() => configureElectronProfile(app, paths)).toThrow(
      'Electron storage paths must be configured before app ready'
    );
    expect(app.setPath).not.toHaveBeenCalled();
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
