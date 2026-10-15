import type { App } from 'electron';

import type { CodeBuddyPaths } from './codeBuddyPaths';

type ElectronProfileApp = Pick<App, 'isReady' | 'setPath'>;

export function configureElectronProfile(app: ElectronProfileApp, paths: CodeBuddyPaths): void {
  if (app.isReady()) {
    throw new Error('Electron storage paths must be configured before app ready');
  }

  app.setPath('userData', paths.electronUserDataDir);
  app.setPath('sessionData', paths.electronSessionDataDir);
}

export function profilePartition(profileId: string): string {
  if (profileId !== 'local') {
    throw new Error('Only the local profile is supported');
  }
  return 'persist:profile-local';
}
