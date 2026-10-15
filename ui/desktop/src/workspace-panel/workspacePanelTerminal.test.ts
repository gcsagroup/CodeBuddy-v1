import { describe, expect, it } from 'vitest';
import { terminalModulePath, terminalShell } from './workspacePanelTerminal';

describe('packaged terminal platform boundaries', () => {
  it('leaves Unix module resolution in ASAR so node-pty converts spawn-helper exactly once', () => {
    const entry =
      '/Applications/CodeBuddy.app/Contents/Resources/app.asar/node_modules/node-pty/lib/index.js';
    const loaded = terminalModulePath(entry, true, 'darwin');
    // node-pty 1.1.0 applies this conversion internally in unixTerminal.js.
    const helper = loaded
      .replace('lib/index.js', 'build/Release/spawn-helper')
      .replace('app.asar', 'app.asar.unpacked');
    expect(helper).toBe(
      '/Applications/CodeBuddy.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper'
    );
    expect(terminalModulePath(entry, true, 'linux')).toBe(entry);
  });
  it('keeps Windows ConPTY workers on real filesystem paths', () => {
    const entry = 'C:\\App\\resources\\app.asar\\node_modules\\node-pty\\lib\\index.js';
    expect(terminalModulePath(entry, true, 'win32')).toContain('app.asar.unpacked');
    expect(terminalModulePath(entry, false, 'win32')).toBe(entry);
  });
  it('starts macOS login shells to load tools installed through the user profile', () => {
    expect(terminalShell('darwin', {})).toEqual({ file: '/bin/zsh', args: ['-l'] });
    expect(terminalShell('darwin', { SHELL: '/opt/homebrew/bin/fish' })).toEqual({
      file: '/opt/homebrew/bin/fish',
      args: ['-l'],
    });
    expect(terminalShell('linux', {})).toEqual({ file: '/bin/bash', args: [] });
    expect(terminalShell('win32', { SystemRoot: 'D:\\Windows' }).file).toBe(
      'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    );
  });
});
