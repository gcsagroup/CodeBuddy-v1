import { app, dialog } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPlan } from '../../../../runtime/macos-uninstall.cjs';

type Translate = (english: string, simplified: string, traditional: string) => string;
let pending = false;

// A native menu action keeps destructive cleanup out of renderer IPC and model tools.
export async function showMacUninstall(options: {
  dataRoot: string; workspace: string; runtimePid?: number; t: Translate;
}): Promise<void> {
  if (pending || process.platform !== 'darwin' || !app.isPackaged) return;
  pending = true;
  let committed = false;
  const t = options.t;
  try {
    const choice = await dialog.showMessageBox({
      type: 'question', title: t('Uninstall CodeBuddy', '卸载 CodeBuddy', '解除安裝 CodeBuddy'),
      message: t('Choose what to keep', '选择需要保留的内容', '選擇需要保留的內容'),
      detail: t(
        'Keep data: remove the app, keeping models, chats, pets and projects for a later reinstall.\n\nClean app data: also remove settings, chats, pets, caches and dedicated credentials. Projects are kept unless you explicitly select them in the next step.\n\nThis is not needed for an update.',
        '保留数据：移除应用，保留模型配置、聊天、宠物和项目，重装后可继续使用。\n\n清理应用数据：同时清理配置、聊天、宠物、缓存及专用凭据。项目默认保留，下一步可单独选择。\n\n更新版本不需要卸载。',
        '保留資料：移除應用程式，保留模型設定、聊天、寵物和專案，重新安裝後可繼續使用。\n\n清理應用資料：同時清理設定、聊天、寵物、快取及專用憑證。專案預設保留，下一步可單獨選擇。\n\n更新版本不需要解除安裝。'),
      buttons: [t('Keep data (recommended)', '保留数据（推荐）', '保留資料（推薦）'),
        t('Clean app data…', '清理应用数据…', '清理應用資料…'), t('Cancel', '取消', '取消')],
      defaultId: 0, cancelId: 2, noLink: true,
    });
    if (choice.response === 2) return;
    let deleteProjects = false;
    const cleanData = choice.response === 1;
    if (cleanData) {
      const projects = await dialog.showMessageBox({
        type: 'warning', title: 'CodeBuddy',
        message: t('Projects are kept by default', '项目默认保留', '專案預設保留'),
        detail: t('Only the two managed workspace folders below can be selected. Other project locations and unknown files are always kept.',
          '勾选后将额外删除下列两个应用管理的工作区及其中作品。其他项目位置和未知文件始终保留。',
          '勾選後將額外刪除下列兩個應用管理的工作區及其中作品。其他專案位置和未知檔案一律保留。') +
          `\n\n${path.join(options.dataRoot, 'workspaces')}\n${path.join(options.dataRoot, 'backend/workspaces')}`,
        checkboxLabel: t('Also delete these workspaces and generated work', '同时删除上述工作区和生成作品', '同時刪除上述工作區和產生作品'),
        checkboxChecked: false,
        buttons: [t('Review uninstall', '查看卸载清单', '查看解除安裝清單'), t('Cancel', '取消', '取消')],
        defaultId: 0, cancelId: 1, noLink: true,
      });
      if (projects.response !== 0) return;
      deleteProjects = projects.checkboxChecked;
    }
    const plan = await createPlan({ app: path.resolve(process.resourcesPath, '../..'),
      home: os.homedir(), dataRoot: options.dataRoot, workspace: options.workspace, cleanData, deleteProjects });
    const confirm = await dialog.showMessageBox({
      type: 'warning', title: 'CodeBuddy',
      message: t('Quit and uninstall CodeBuddy?', '退出并卸载 CodeBuddy？', '退出並解除安裝 CodeBuddy？'),
      detail: t('Running tasks will stop. The selected files will be permanently removed.',
        '正在运行的任务将停止。下列选定文件将永久删除。', '正在執行的任務將停止。下列選定檔案將永久刪除。') +
        `\n\n${plan.targets.map(item => item.path).join('\n')}\n\n` +
        t('Estimated logical size', '预计逻辑大小', '預計邏輯大小') + `: ${(plan.bytes / 1048576).toFixed(1)} MiB\n` +
        t('Shared disk blocks can make the actual space reclaimed smaller.', '共享磁盘块可能使实际释放空间小于此数值。', '共用磁碟區塊可能使實際釋放空間小於此數值。') +
        (cleanData ? '\n\n' + t('Also reset this app’s privacy grants and remove its dedicated Keychain key.',
          '同时重置本应用隐私授权并清理专用钥匙串密钥。', '同時重設本應用隱私授權並清理專用鑰匙圈金鑰。') : '') +
        '\n\n' + t('Preserved projects', '保留的项目位置', '保留的專案位置') + `:\n${plan.preserved.join('\n')}`,
      buttons: [t('Cancel', '取消', '取消'), t('Quit and uninstall', '退出并卸载', '退出並解除安裝')],
      defaultId: 0, cancelId: 0, noLink: true,
    });
    if (confirm.response !== 1) return;
    const root = path.join(process.resourcesPath, 'harness-distribution');
    const reportDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'codebuddy-uninstall-'));
    const worker = spawn(path.join(root, 'node/node'), [path.join(root, 'runtime/macos-uninstall.cjs')], {
      detached: true, cwd: reportDirectory, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir() },
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { worker.kill(); reject(new Error('Uninstall helper did not start')); }, 10000);
      worker.once('error', error => { clearTimeout(timer); reject(error); });
      worker.once('exit', code => { clearTimeout(timer); reject(new Error(`Uninstall helper exited: ${code}`)); });
      worker.once('message', message => {
        if ((message as { type?: string })?.type !== 'ready') return;
        clearTimeout(timer);
        worker.send({ type: 'confirmed', plan, workspace: options.workspace, reportDirectory,
          pids: [process.pid, ...(options.runtimePid ? [options.runtimePid] : [])],
          doneText: t('CodeBuddy was uninstalled. Preserved projects and per-item results are listed in:',
            'CodeBuddy 卸载完成。保留项目及逐项结果见：', 'CodeBuddy 解除安裝完成。保留專案及逐項結果見：'),
          failureText: t('Uninstall was incomplete. Review remaining items in:',
            '卸载未全部完成，请查看残留项与原因：', '解除安裝未全部完成，請查看殘留項與原因：'),
        }, error => error ? reject(error) : resolve());
      });
    });
    worker.unref();
    committed = true;
    app.quit(); // Existing before-quit hook drains Harness/MCP before the helper deletes files.
  } catch (error) {
    await dialog.showMessageBox({ type: 'error', title: 'CodeBuddy',
      message: t('Uninstall did not start', '卸载未开始', '解除安裝未開始'),
      detail: error instanceof Error ? error.message : String(error) });
  } finally { if (!committed) pending = false; }
}
