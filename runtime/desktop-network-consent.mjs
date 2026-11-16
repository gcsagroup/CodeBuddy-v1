import { readFileSync } from 'node:fs';
import path from 'node:path';

// The packaged service and desktop preview share Electron's settings directory.
// Standalone Harness callers do not have a desktop consent UI.
export function desktopNetworkAllowed() {
  const directory = process.env.CODEBUDDY_USER_DATA_DIR;
  if (!directory) return true;
  try {
    return JSON.parse(readFileSync(path.join(directory, 'settings.json'), 'utf8')).networkAccessAllowed === true;
  } catch {
    return false;
  }
}
