import { describe, expect, it } from 'vitest';
import { trayIconFileName, trayTooltip, windowIconFileName, windowsAppUserModelId } from './appIcons';

describe('CodeBuddy application icons', () => {
  it('uses the branded application icon for Windows windows and tray', () => {
    expect(windowIconFileName('win32')).toBe('icon.ico');
    expect(trayIconFileName('win32')).toBe('icon.ico');
    expect(trayTooltip).toBe('CodeBuddy');
  });

  it('keeps native macOS icon formats', () => {
    expect(windowIconFileName('darwin')).toBe('icon.icns');
    expect(trayIconFileName('darwin')).toBe('iconTemplate.png');
  });

  it('keeps update and normal tray states on the same platform artwork', () => {
    expect(trayIconFileName('win32', true)).toBe('iconUpdate.ico');
    expect(trayIconFileName('darwin', true)).toBe('iconTemplateUpdate.png');
    expect(trayIconFileName('linux', true)).toBe('iconUpdate.png');
    expect(trayIconFileName('linux', false)).toBe('icon.png');
  });

  it('matches the installed Squirrel shortcut without grouping preview windows with Electron', () => {
    expect(windowsAppUserModelId(true)).toBe('com.squirrel.CodeBuddyHarness.CodeBuddy');
    expect(windowsAppUserModelId(false)).toBe('local.codebuddy.harness.preview');
  });
});
