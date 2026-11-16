import { app, autoUpdater, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { githubUpdateCredential } from '../github/githubCliAuth';
import { GitHubReleaseSource } from './githubRelease';
import { UpdateController } from './controller';
import { MacUpdateInstaller, prepareWindowsInstall, previousInstallError } from './nativeInstall';
import { selectNativeText } from '../utils/nativeLocalization';
import type { UpdateChannel } from './types';
import log from '../utils/logger';

export function registerProductUpdates(options: {
  requestNetworkAccess: (event: Electron.IpcMainInvokeEvent) => Promise<boolean>;
  closeForUpdate: () => Promise<void>;
  hasTerminals: () => boolean;
  reserveTerminals: () => () => void;
}) {
  const directory = path.join(app.getPath('userData'), 'updates');
  const mac = new MacUpdateInstaller();
  // Native callbacks can arrive after cancellation; operation listeners handle
  // current failures, and delayed errors must not crash the application.
  autoUpdater.on('error', () => log.warn('Native application update reported an error.'));
  // Called after the packaged runtime has reported ready, not merely after an
  // installer process exits. Acceptance can distinguish installed from running.
  if (app.isPackaged)
    void mkdir(directory, { recursive: true })
      .then(() =>
        writeFile(
          path.join(directory, 'running-version.json'),
          JSON.stringify({
            version: app.getVersion(),
            executable: app.getPath('exe'),
            readyAt: new Date().toISOString(),
          })
        )
      )
      .catch(() => undefined);
  const controller = new UpdateController({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    directory,
    initialError: previousInstallError(directory, app.getVersion()),
    source: new GitHubReleaseSource(githubUpdateCredential),
    emit: (state) => {
      for (const win of BrowserWindow.getAllWindows())
        win.webContents.send('updater-event', { event: 'state', data: state });
    },
    install: async (candidate, file) => {
      if (!app.isPackaged) throw new Error('源码预览仅支持检查更新，请在安装版中执行升级。');
      if (!['win32', 'darwin'].includes(process.platform))
        throw new Error('当前平台尚未支持自动更新。');
      const t = (en: string, cn: string, tw: string) =>
        selectNativeText(app.getLocale(), en, cn, tw);
      const answer = await dialog.showMessageBox({
        type: 'warning',
        title: 'CodeBuddy',
        message: t(
          'Restart and update CodeBuddy?',
          '重启并更新 CodeBuddy？',
          '重新啟動並更新 CodeBuddy？'
        ),
        detail: t(
          'Restarting stops running conversations and automation tasks and closes terminals. Save open files first. Saved chats, settings and workspace files will be retained. Interrupted work will not resume automatically; continue it from the conversation after restarting. Choose Later to keep working.',
          '重启会停止正在执行的对话和自动任务，并关闭终端。请先保存打开的文件。已保存的聊天记录、配置和工作区文件会保留；被中断的工作不会自动续跑，更新后可回到对话继续。选择“稍后”可继续当前任务。',
          '重新啟動會停止執行中的對話與自動工作，並關閉終端。請先儲存開啟的檔案。已儲存的聊天記錄、設定與工作區檔案會保留；中斷的工作不會自動繼續，更新後可回到對話繼續。選擇「稍後」可繼續目前工作。'
        ) + (options.hasTerminals() ? '\n\n' + t(
          'There are open terminals. Their running commands may be interrupted.',
          '当前有打开的终端，其中正在运行的命令可能被中断。',
          '目前有開啟的終端，其中執行中的命令可能被中斷。'
        ) : ''),
        buttons: [
          t('Later', '稍后', '稍後'),
          t('Stop tasks and update', '停止任务并重启更新', '停止工作並重新啟動更新'),
        ],
        defaultId: 0,
        cancelId: 0,
      });
      if (answer.response !== 1) return false;
      const releaseTerminals = options.reserveTerminals();
      try {
        if (process.platform === 'win32') {
          let install: Awaited<ReturnType<typeof prepareWindowsInstall>> | undefined;
          let closed = false;
          try {
            await options.closeForUpdate();
            closed = true;
            // Start the helper deadline only after task cancellation and saving.
            install = await prepareWindowsInstall(candidate, file, directory);
            await install.commit();
          } catch (error) {
            install?.cancel();
            if (closed) {
              app.relaunch();
              app.quit();
            }
            throw error;
          }
          app.quit();
        } else {
          await options.closeForUpdate();
          try {
            // Squirrel installs staged updates on ordinary application exit too.
            // Hand it bytes only after consent, task settlement and durable saves.
            await mac.stage(candidate, file, globalThis.AbortSignal.timeout(5 * 60 * 1000));
            await mac.install();
          } catch (error) {
            app.relaunch();
            app.quit();
            throw error;
          }
        }
      } catch (error) {
        releaseTerminals();
        throw error;
      }
      return undefined;
    },
  });
  ipcMain.handle('check-for-updates', async (event, channel: UpdateChannel = 'preview') => {
    if (!await options.requestNetworkAccess(event)) return controller.state;
    await controller.check(channel);
    return controller.state;
  });
  ipcMain.handle('download-update', async event => {
    if (!await options.requestNetworkAccess(event)) return controller.state;
    await controller.download();
    return controller.state;
  });
  ipcMain.handle('install-update', async () => {
    await controller.install();
    return controller.state;
  });
  ipcMain.handle('cancel-update', () => controller.cancel());
  ipcMain.handle('get-update-state', () => controller.state);
  ipcMain.handle('get-current-version', () => app.getVersion());
  ipcMain.handle('is-using-github-fallback', () => false);
  ipcMain.handle('get-auto-download-disabled', () => true);
  app.on('will-quit', () => {
    controller.cancel();
    mac.close();
  });
}
