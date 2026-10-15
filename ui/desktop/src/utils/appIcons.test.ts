import { describe, expect, it } from 'vitest';
import { trayIconFileName, trayTooltip, windowIconFileName } from './appIcons';

describe('CodeBuddy application icons', () => {
  it('uses the branded application icon for Windows windows and tray', () => {
    expect(windowIconFileName('win32')).toBe('icon.ico');
    expect(trayIconFileName('win32')).toBe('icon.png');
    expect(trayTooltip).toBe('CodeBuddy');
  });

  it('keeps native macOS icon formats', () => {
    expect(windowIconFileName('darwin')).toBe('icon.icns');
    expect(trayIconFileName('darwin')).toBe('iconTemplate.png');
  });
});
