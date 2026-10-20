import type { App, Session } from 'electron';
import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';

import type { CodeBuddyPaths } from './codeBuddyPaths';

type ElectronProfileApp = Pick<App, 'isReady' | 'setPath'> & {
  commandLine: Pick<App['commandLine'], 'appendSwitch'>;
};
export const HTTP_CACHE_BYTES = 128 * 1024 * 1024;
export const CODE_CACHE_BYTES = 64 * 1024 * 1024;

export function configureElectronProfile(app: ElectronProfileApp, paths: CodeBuddyPaths): void {
  if (app.isReady()) {
    throw new Error('Electron storage paths must be configured before app ready');
  }

  app.setPath('userData', paths.electronUserDataDir);
  app.setPath('sessionData', paths.electronSessionDataDir);
  app.commandLine.appendSwitch('disk-cache-size', String(HTTP_CACHE_BYTES));
}

async function codeCacheExceeds(directory: string): Promise<boolean> {
  let bytes = 0;
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop()!;
    let entries;
    try {
      if (!(await lstat(current)).isDirectory()) continue;
      entries = await opendir(current);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') continue;
      throw error;
    }
    for await (const entry of entries) {
      // Never follow links into user projects or another profile.
      if (entry.isDirectory()) pending.push(join(current, entry.name));
      else if (entry.isFile()) {
        try {
          bytes += (await lstat(join(current, entry.name))).size;
        } catch (error) {
          if ((error as { code?: string }).code !== 'ENOENT') throw error;
        }
        if (bytes > CODE_CACHE_BYTES) return true;
      }
    }
  }
  return false;
}

// Only Electron's regenerable HTTP/compiled-script caches are eligible.
// Cookies, IndexedDB, local storage, sessions and user files are never cleared.
export async function maintainElectronCache(
  target: Pick<Session, 'getCacheSize' | 'clearCache' | 'clearCodeCaches' | 'storagePath'>
): Promise<void> {
  if ((await target.getCacheSize()) > HTTP_CACHE_BYTES) await target.clearCache();
  if (target.storagePath && (await codeCacheExceeds(join(target.storagePath, 'Code Cache')))) {
    await target.clearCodeCaches({});
  }
}

export function profilePartition(profileId: string): string {
  if (profileId !== 'local') {
    throw new Error('Only the local profile is supported');
  }
  return 'persist:profile-local';
}
