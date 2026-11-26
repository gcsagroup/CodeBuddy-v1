import { dialog, type BrowserWindow, type Event, type RenderProcessGoneDetails } from 'electron';
import log from './utils/logger';

type Translate = (english: string, simplified: string, traditional: string) => string;

// Recover the existing window/URL only. Session loading owns reconnection;
// this layer must never submit a prompt, cancel a run or replay a tool.
export function registerMainWindowRecovery(window: BrowserWindow, t: Translate) {
  const contents = window.webContents;
  let failure: 'gone' | 'unresponsive' | 'load' | undefined;
  let failedUrl: string | undefined;
  let navigationFailed = false;
  let reason: string | undefined;
  let revision = 0;
  let prompting = false;
  let closed = false;

  async function offerRecovery() {
    if (prompting || closed || !failure || window.isDestroyed()) return;
    prompting = true;
    const observedRevision = revision;
    const gone = failure === 'gone';
    const loadFailed = failure === 'load';
    const reopen = gone || loadFailed ? 0 : 1;
    const retryUrl = failedUrl;
    try {
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning',
        title: 'CodeBuddy',
        message: loadFailed
          ? t('Could not load the desktop page', '桌面页面加载失败', '桌面頁面載入失敗')
          : gone
          ? reason === 'oom'
            ? t(
                'The chat interface ran out of memory',
                '聊天界面内存不足，已停止',
                '聊天介面記憶體不足，已停止'
              )
            : t('The chat interface stopped unexpectedly', '聊天界面意外停止', '聊天介面意外停止')
          : t('The chat interface is not responding', '聊天界面暂时无响应', '聊天介面暫時無回應'),
        detail: loadFailed ? t(
          'The desktop page could not be opened. Retry to load it again. If this continues, check the application logs. Saved conversations and files are kept.',
          '桌面页面未能打开。可以重试加载；如果仍然失败，请检查应用日志。已保存的会话记录和文件会保留。',
          '桌面頁面未能開啟。可以重試載入；如果仍然失敗，請檢查應用程式記錄。已儲存的對話紀錄和檔案會保留。'
        ) + '\n\n' + reason : t(
          'Reopening restores the interface without sending the task again. Saved conversations and files are kept. The task status will be checked after the interface reconnects.',
          '重新打开只恢复界面，不会重新发送任务。已保存的会话记录和文件会保留，任务状态将在恢复连接后重新确认。',
          '重新開啟只恢復介面，不會重新傳送任務。已儲存的對話紀錄和檔案會保留，任務狀態將在恢復連線後重新確認。'
        ),
        buttons: gone || loadFailed
          ? [t('Reopen', '重新打开', '重新開啟'), t('Not now', '暂不处理', '暫不處理')]
          : [t('Keep waiting', '继续等待', '繼續等待'), t('Reopen', '重新打开', '重新開啟')],
        defaultId: 0,
        cancelId: gone || loadFailed ? 1 : 0,
        noLink: true,
      });
      // A manual reload, recovery or another failure can obsolete this dialog.
      if (!closed && !window.isDestroyed() && revision === observedRevision && response === reopen) {
        if (loadFailed && retryUrl) {
          // Failed initial navigation may leave getURL() empty; retry its real URL.
          void window.loadURL(retryUrl).catch(error => {
            if (!closed) log.error('Desktop page retry failed', error);
          });
        } else window.reload();
      }
    } catch (error) {
      if (!closed) log.error('Could not show main window recovery', error);
    } finally {
      prompting = false;
      if (!closed && failure && revision !== observedRevision) void offerRecovery();
    }
  }

  const onGone = (_event: Event, details: RenderProcessGoneDetails) => {
    log.error('Main chat renderer exited', { reason: details.reason, exitCode: details.exitCode });
    if (failure !== 'gone' || reason !== details.reason) {
      failure = 'gone';
      reason = details.reason;
      revision++;
    }
    void offerRecovery();
  };
  const onUnresponsive = () => {
    if (failure) return;
    failure = 'unresponsive';
    revision++;
    void offerRecovery();
  };
  const onResponsive = () => {
    if (failure === 'unresponsive') {
      failure = undefined;
      revision++;
    }
  };
  const onLoaded = () => {
    // Chromium can finish loading its internal error document after did-fail-load.
    if (navigationFailed) return;
    failure = undefined;
    failedUrl = undefined;
    revision++;
  };
  const onNavigation = (_event: Event, _url: string, inPlace: boolean, isMainFrame: boolean) => {
    if (!isMainFrame || inPlace) return;
    navigationFailed = false;
    failure = undefined;
    failedUrl = undefined;
    revision++;
  };
  const onLoadFailed = (_event: Event, code: number, description: string, url: string, isMainFrame: boolean) => {
    if (!isMainFrame || code === -3 || closed) return;
    log.error('Desktop page failed to load', { code, description, url });
    failure = 'load';
    navigationFailed = true;
    reason = `${description} (${code})`;
    failedUrl = url;
    revision++;
    window.show();
    void offerRecovery();
  };
  contents.on('render-process-gone', onGone);
  contents.on('did-finish-load', onLoaded);
  contents.on('did-fail-load', onLoadFailed);
  contents.on('did-start-navigation', onNavigation);
  window.on('unresponsive', onUnresponsive);
  window.on('responsive', onResponsive);
  window.once('closed', () => {
    closed = true;
    // BrowserWindow.webContents throws once the native window has been destroyed.
    contents.removeListener('render-process-gone', onGone);
    contents.removeListener('did-finish-load', onLoaded);
    contents.removeListener('did-fail-load', onLoadFailed);
    contents.removeListener('did-start-navigation', onNavigation);
    window.removeListener('unresponsive', onUnresponsive);
    window.removeListener('responsive', onResponsive);
  });
}
