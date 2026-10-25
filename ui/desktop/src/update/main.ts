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
      if (options.hasTerminals()) throw new Error('请先保存终端中的工作并关闭终端，再重启更新。');
      const t = (en: string, cn: string, tw: string) =>
        selectNativeText(app.getLocale(), en, cn, tw);
      const answer = await dialog.showMessageBox({
        type: 'question',
        title: 'CodeBuddy',
        message: t(
          'Restart and update CodeBuddy?',
          '重启并更新 CodeBuddy？',
          '重新啟動並更新 CodeBuddy？'
        ),
        detail: t(
          'Save open files first. Chats, settings and workspaces will be retained. Running tasks must finish before updating.',
          '请先保存打开的文件。聊天记录、配置和工作区会保留；正在执行的任务需完成后再更新。',
          '請先儲存開啟的檔案。聊天記錄、設定與工作區會保留；執行中的工作需完成後再更新。'
        ),
        buttons: [
          t('Later', '稍后', '稍後'),
          t('Restart and update', '重启并更新', '重新啟動並更新'),
        ],
        defaultId: 0,
        cancelId: 0,
      });
      if (answer.response !== 1) throw new Error('已保留下载，稍后可以继续更新。');
      const releaseTerminals = options.reserveTerminals();
      try {
        if (process.platform === 'win32') {
          const install = await prepareWindowsInstall(candidate, file, directory);
          let closed = false;
          try {
            await options.closeForUpdate();
            closed = true;
            await install.commit();
          } catch (error) {
            install.cancel();
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
            // Hand it bytes only after explicit consent and the runtime idle fence.
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
    },
  });
  ipcMain.handle('check-for-updates', async (_event, channel: UpdateChannel = 'preview') => {
    await controller.check(channel);
    return controller.state;
  });
  ipcMain.handle('download-update', async () => {
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
