import { ipcMain } from 'electron';
import { GitHubCliLogin, githubCliLogout, githubCliStatus } from './githubCliAuth';
export function registerGitHubCliAuth(): void {
  const owners = new Map<number, GitHubCliLogin>();
  ipcMain.handle('github-cli-status', () => githubCliStatus());
  ipcMain.handle('github-cli-logout', (_event, login: unknown) => githubCliLogout(login));
  ipcMain.handle('github-cli-login-start', (event) => {
    let owner = owners.get(event.sender.id);
    if (!owner) {
      owner = new GitHubCliLogin();
      owners.set(event.sender.id, owner);
      const owned = owner;
      const id = event.sender.id;
      event.sender.once('destroyed', () => {
        owned.cancel();
        owners.delete(id);
      });
    }
    return owner.start();
  });
  ipcMain.handle('github-cli-login-poll', (event, flowId: unknown) => {
    if (typeof flowId !== 'string' || flowId.length > 64) throw new Error('Invalid login flow');
    const owner = owners.get(event.sender.id);
    if (!owner) throw new Error('GitHub login flow not found');
    return owner.poll(flowId);
  });
  ipcMain.handle('github-cli-login-cancel', (event, flowId: unknown) => {
    if (typeof flowId !== 'string' || flowId.length > 64) throw new Error('Invalid login flow');
    owners.get(event.sender.id)?.cancel(flowId);
  });
}
