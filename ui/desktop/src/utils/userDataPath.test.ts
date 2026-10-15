import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCodeBuddyUserDataDir } from './userDataPath';

describe('resolveCodeBuddyUserDataDir', () => {
  it('keeps the normal Electron profile when no override is configured', () => {
    expect(resolveCodeBuddyUserDataDir(undefined)).toBeUndefined();
    expect(resolveCodeBuddyUserDataDir('   ')).toBeUndefined();
  });

  it('accepts and normalizes only absolute isolated profile paths', () => {
    const absolute = path.join(path.parse(process.cwd()).root, 'codebuddy-lifecycle-profile');
    expect(resolveCodeBuddyUserDataDir(absolute)).toBe(path.normalize(absolute));
    expect(() => resolveCodeBuddyUserDataDir('relative/profile')).toThrow(
      'CODEBUDDY_USER_DATA_DIR must be an absolute path'
    );
  });
});
