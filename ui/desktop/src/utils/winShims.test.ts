import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { windowsShimSourceDirectory } from './winShims';

describe('windowsShimSourceDirectory', () => {
  it('uses the staged application bin directory in development', () => {
    expect(
      windowsShimSourceDirectory({
        isPackaged: false,
        resourcesPath: path.join('electron', 'resources'),
        appPath: path.join('D:', 'CodeBuddy', 'ui', 'desktop'),
      })
    ).toBe(path.join('D:', 'CodeBuddy', 'ui', 'desktop', 'src', 'bin'));
  });

  it('uses the packaged resources bin directory in production', () => {
    expect(
      windowsShimSourceDirectory({
        isPackaged: true,
        resourcesPath: path.join('CodeBuddy', 'resources'),
        appPath: path.join('CodeBuddy', 'resources', 'app.asar'),
      })
    ).toBe(path.join('CodeBuddy', 'resources', 'bin'));
  });
});
