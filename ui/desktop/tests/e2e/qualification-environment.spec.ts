import { expect, test } from '@playwright/test';
import { buildQualificationChildEnvironment } from './fixtures';

test.describe('isolated desktop build environment', () => {
  test('preserves Windows tool discovery roots without inheriting accounts or credentials', () => {
    const parent: NodeJS.ProcessEnv = {
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      ProgramFiles: 'C:\\Program Files',
      USERPROFILE: 'C:\\real-user',
      APPDATA: 'C:\\real-user\\AppData',
    };
    Object.defineProperty(parent, 'PRIVATE_API_KEY', {
      enumerable: true,
      get: () => {
        throw new Error('real credential was accessed');
      },
    });
    const environment = buildQualificationChildEnvironment(parent, {
      profileRoot: 'C:\\isolated-test',
      appData: 'C:\\isolated-test\\AppData',
      localAppData: 'C:\\isolated-test\\Local',
      codeBuddyHome: 'C:\\isolated-test\\.CodeBuddy',
      temporaryDirectory: 'C:\\isolated-test\\Temp',
    });
    expect(environment['ProgramFiles(x86)']).toBe(parent['ProgramFiles(x86)']);
    expect(environment.ProgramFiles).toBe(parent.ProgramFiles);
    expect(environment.USERPROFILE).toBe('C:\\isolated-test');
    expect(environment.APPDATA).toBe('C:\\isolated-test\\AppData');
    expect(Object.prototype.hasOwnProperty.call(environment, 'PRIVATE_API_KEY')).toBe(false);
    expect(environment.COREPACK_ENABLE_NETWORK).toBe('0');
  });
});
