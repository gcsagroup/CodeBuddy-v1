import path from 'node:path';

export function terminalModulePath(entry: string, packaged: boolean, platform: string) {
  // Unix node-pty performs its own ASAR -> unpacked conversion for spawn-helper.
  // Loading Unix JS from the unpacked tree would apply that conversion twice.
  return packaged && platform === 'win32'
    ? entry.replace(/([/\\])app\.asar([/\\])/, '$1app.asar.unpacked$2')
    : entry;
}

export function terminalShell(platform: string, env: Record<string, string | undefined>) {
  if (platform === 'win32') {
    return {
      file: path.win32.join(
        env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      ),
      args: ['-NoLogo', '-NoProfile'],
    };
  }
  // Finder supplies a minimal environment; a login shell loads the user's PATH.
  return {
    file: env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash'),
    args: platform === 'darwin' ? ['-l'] : [],
  };
}
