import type { IpcMainInvokeEvent } from 'electron';
import { registerDesktopControl } from './desktopControlMain';
import { registerWindowMenu } from './windowMenu';
import { revealChatOnActivate } from './utils/revealChatOnActivate';
import { registerMainWindowRecovery } from './mainWindowRecovery';
import { maintainVisibleWindowFrames } from './utils/windowAnimation';
import { TaskWakelock } from './taskWakelock';
import { applicationWindows, markAuxiliaryWindow, registerDesktopPet } from './pets/petMain';
import { registerTrayLifecycle } from './utils/trayLifecycle';
import { registerGitHubCliAuth } from './github/githubCliMain';
import { registerProductUpdates } from './update/main';
import { startHarnessService } from './harnessService';
import { showMacUninstall } from './storage/macosUninstall';
import { locationFile, readDataRoot, assertNoMigration } from '../../../runtime/storage-management.cjs';
import { readFileResponse } from './storage/readFileResponse';
import { registerPastedTextOpen } from './pastedTextMain';
import {
  registerWorkspacePanel,
  registerWorkspaceMediaSession,
  hasWorkspaceTerminals,
  reserveWorkspaceUpdate,
} from './workspace-panel/workspacePanelMain';
import type { OpenDialogOptions, OpenDialogReturnValue, Session } from 'electron';
import {
  app,
  App,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  MenuItem,
  net,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  screen,
  session,
  shell,
  Tray,
} from 'electron';
import { pathToFileURL, format as formatUrl, URLSearchParams } from 'node:url';
import { showCompletionPopup } from './completionPopupMain';
import { previewToastActivator, registerPreviewShortcut } from './utils/previewShortcut';
import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import started from 'electron-squirrel-startup';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'child_process';
import 'dotenv/config';
import { checkBackendStatus } from './backendStatus';
import { getBackendCertificateSha256Fingerprint } from './backendCertificateTrust';
import { resolveStartupDirectory } from './startupDirectory';
import { FileOpenQueue } from './fileOpenQueue';
import { resolveCodeProEntryPath } from './codepro/unifiedMode';
import { GooseServeLeaseRegistry, type GooseServeLease } from './gooseServeLeaseRegistry';
import { acpWebSocketUrlFromHttpBase, normalizeAcpHttpBaseUrl } from './acp/url';
import { expandTilde, sanitizeGoosePathRoot } from './utils/pathUtils';
import log from './utils/logger';
import { addRecentDir, loadRecentDirs, onRecentDirsChanged } from './utils/recentDirs';
import { openProjectFolderInWindow } from './openProjectFolder';
import { DraftStore } from './drafts/draftStore';
import { formatAppName, errorMessage, formatErrorForLogging } from './utils/conversionUtils';
import { isRetiredGooseChatApp } from './utils/retiredApps';
import { resolveWorkspaceFilePath } from './utils/safeWorkspacePath';
import { rootCleanupDialogOptions } from './utils/rootCleanupPicker';
import { selectNativeText } from './utils/nativeLocalization';
import type { Settings, SettingKey } from './utils/settings';
import { defaultSettings, getKeyboardShortcuts } from './utils/settings';
import { defaultTypography, readTypography, zoomRange, type Typography } from './utils/typography';
import * as crypto from 'crypto';
import * as yaml from 'yaml';
import windowStateKeeper from 'electron-window-state';
import { configureTray, setAutoDownloadDisabled } from './utils/autoUpdater';
import './utils/recipeHash';
import type { GooseApp } from './types/apps';
import installExtension, { REACT_DEVELOPER_TOOLS } from 'electron-devtools-installer';
import { BLOCKED_PROTOCOLS, WEB_PROTOCOLS } from './utils/urlSecurity';
import { buildCSP } from './utils/csp';
import distro from '../codebuddy.distro.json';
import { hasSupportedDeepLinkPrefix, PRIMARY_DEEP_LINK_PREFIX } from './utils/deepLinkProtocol';
import { listGitWorktreeDirs } from './codepro/workspaceOperations';
import { confirmCodeProWorkspace, inspectCodeProWorkspace } from './codepro/projectWorkspace';
import {
  trayIconFileName,
  trayTooltip,
  windowIconFileName,
  windowsAppUserModelId,
} from './utils/appIcons';
import { resolveCodeBuddyUserDataDir } from './utils/userDataPath';
import {
  applyLegacyEnvironment,
  resolveCodeBuddyPaths,
  resolvePackagedCodeBuddyHome,
} from './storage/codeBuddyPaths';
import {
  configureElectronProfile,
  profilePartition,
  maintainElectronCache,
} from './storage/electronProfile';

// Preview and packaged launches use the same data root unless explicitly isolated.
// A missing launcher configuration must never fall back to the retired backend.
const harnessPreview = process.env.CODEBUDDY_HARNESS_PREVIEW === '1';
const harnessPackaged = app.isPackaged;
// This product has one Agent runtime. Development must use start-preview.ps1.
if (harnessPackaged) {
  if (!process.env.CODEBUDDY_HOME) {
    try {
      const locator = locationFile();
      assertNoMigration(locator);
      process.env.CODEBUDDY_HOME = readDataRoot(locator, resolvePackagedCodeBuddyHome(os.homedir()));
      if (fsSync.existsSync(path.join(process.env.CODEBUDDY_HOME, '.codebuddy-migration')))
        throw new Error('所选目录包含未完成的迁移，请保留原数据并在设置中重新迁移');
    } catch (error) {
      dialog.showErrorBox('CodeBuddy 数据目录', error instanceof Error ? error.message : String(error));
      app.exit(1);
      throw error;
    }
  }
  process.env.CODEBUDDY_MIGRATE_LEGACY = 'false';
  process.env.CODEBUDDY_DISABLE_PROTOCOL_REGISTRATION = 'true';
}
let packagedHarnessService: Awaited<ReturnType<typeof startHarnessService>> | undefined;
let packagedHomePending = harnessPackaged;
let previewInitialRoute =
  harnessPreview &&
  ['/configure-providers', '/codepro/configure-providers'].includes(
    process.env.CODEBUDDY_PREVIEW_INITIAL_ROUTE ?? ''
  )
    ? process.env.CODEBUDDY_PREVIEW_INITIAL_ROUTE
    : undefined;
if (harnessPreview) {
  if (
    !process.env.CODEBUDDY_HOME ||
    !process.env.CODEBUDDY_EXTERNAL_BACKEND ||
    !process.env.CODEBUDDY_EXTERNAL_BACKEND_URL ||
    !process.env.CODEBUDDY_SERVER__SECRET_KEY
  ) {
    throw new Error('Start CodeBuddy with scripts/start-harness-preview.cjs');
  }
  process.env.CODEBUDDY_DISABLE_PROTOCOL_REGISTRATION = 'true';
  process.env.CODEBUDDY_MIGRATE_LEGACY = 'false';
}

applyLegacyEnvironment(process.env);
const storagePaths = resolveCodeBuddyPaths({
  codeBuddyHome: process.env.CODEBUDDY_HOME,
  goosePathRoot: process.env.GOOSE_PATH_ROOT,
  userHome: os.homedir(),
  platform: process.platform === 'win32' ? 'win32' : 'posix',
});
if (harnessPackaged) {
  try {
    assertNoMigration(locationFile());
    if (fsSync.existsSync(path.join(storagePaths.homeDir, '.codebuddy-migration')))
      throw new Error('该目录包含尚未完成的迁移副本，请使用原数据目录或检查迁移记录。');
  }
  catch (error) {
    dialog.showErrorBox('CodeBuddy 数据目录', error instanceof Error ? error.message : String(error));
    app.exit(1);
  }
}
process.env.CODEBUDDY_HOME = storagePaths.homeDir;
process.env.CODEBUDDY_WORKSPACE_ROOT ||= storagePaths.workspacesDir;
if (!started) {
  configureElectronProfile(app, storagePaths);
  const isolatedUserDataDir = resolveCodeBuddyUserDataDir(process.env.CODEBUDDY_USER_DATA_DIR);
  if (isolatedUserDataDir) app.setPath('userData', isolatedUserDataDir);
  process.env.CODEBUDDY_PET_DIRECTORY = path.join(app.getPath('userData'), 'pets', 'custom');
}

const localProfilePartition = profilePartition('local');

log.info('Desktop startup preflight', {
  squirrelStartup: started,
  backend: 'deepseek-harness',
});

// Keep development and packaged profiles under the same internal Electron name.
// Source: https://www.electronjs.org/docs/latest/api/app#appsetnamename
app.setName(distro.productName);
if (process.platform === 'win32') {
  app.setAppUserModelId(windowsAppUserModelId(app.isPackaged));
  if (!app.isPackaged) app.setToastActivatorCLSID(previewToastActivator);
}

function findSupportedDeepLink(args: string[]): string | undefined {
  return args.find(hasSupportedDeepLinkPrefix);
}

// =======================================================================
// Native menu localization
// -----------------------------------------------------------------------
// Electron's main process can't use react-intl (which runs in the renderer),
// so the native menu bar is translated here with a small hand-maintained
// dictionary. Keep the keys in sync with the raw label strings used below.
// =======================================================================

const MENU_TRANSLATIONS_ZH_CN: Record<string, string> = {
  // Top-level
  File: '文件',
  Edit: '编辑',
  View: '视图',
  Window: '窗口',
  Help: '帮助',
  // Context menu
  'Add to dictionary': '添加到词典',
  Cut: '剪切',
  Copy: '复制',
  Paste: '粘贴',
  // Goose-added items
  'New Window': '新建窗口',
  Settings: '设置',
  'Find…': '查找…',
  'Find Next': '查找下一个',
  'Find Previous': '查找上一个',
  'Use Selection for Find': '用所选内容查找',
  Find: '查找',
  'New Chat': '新建聊天',
  'New Chat Window': '新建聊天窗口',
  'Open Directory...': '打开目录…',
  'Recent Directories': '最近的目录',
  [`Focus ${distro.productName} Window`]: `聚焦 ${distro.productName} 窗口`,
  'Quick Launcher': '快速启动器',
  'Always on Top': '窗口置顶',
  'Toggle Navigation': '切换导航',
  [`About ${distro.productName}`]: `关于 ${distro.productName}`,
  'CodeBuddy Documentation': 'CodeBuddy 使用文档',
  'Report a CodeBuddy Issue': '报告 CodeBuddy 问题',
  // Electron's default role-based labels we want to translate as well.
  // (The menu role itself still provides the correct behaviour; only the
  // display string is overridden.)
  Undo: '撤销',
  Redo: '重做',
  'Select All': '全选',
  Delete: '删除',
  Speech: '语音',
  Reload: '重新加载',
  'Force Reload': '强制重新加载',
  'Toggle Developer Tools': '切换开发者工具',
  'Actual Size': '实际大小',
  'Reset Zoom': '重置缩放',
  'Zoom In': '放大',
  'Zoom Out': '缩小',
  'Toggle Full Screen': '切换全屏',
  'Toggle Fullscreen': '切换全屏',
  Minimize: '最小化',
  Close: '关闭',
  'Close Window': '关闭窗口',
  Quit: '退出',
  Exit: '退出',
  'Bring All to Front': '全部置于最前',
  'Emoji & Symbols': '表情符号',
  'Start Dictation…': '开始听写…',
  [`Hide ${distro.productName}`]: `隐藏 ${distro.productName}`,
  'Hide Others': '隐藏其他',
  'Show All': '全部显示',
  Services: '服务',
};

const MENU_TRANSLATIONS_ZH_TW: Record<string, string> = {
  File: '檔案',
  Edit: '編輯',
  View: '檢視',
  Window: '視窗',
  Help: '說明',
  'Add to dictionary': '加入字典',
  Cut: '剪下',
  Copy: '複製',
  Paste: '貼上',
  'New Window': '新增視窗',
  Settings: '設定',
  'Find…': '尋找…',
  'Find Next': '尋找下一個',
  'Find Previous': '尋找上一個',
  'Use Selection for Find': '使用所選內容尋找',
  Find: '尋找',
  'New Chat': '新增聊天',
  'New Chat Window': '新增聊天視窗',
  'Open Directory...': '開啟目錄…',
  'Recent Directories': '最近使用的目錄',
  [`Focus ${distro.productName} Window`]: `聚焦 ${distro.productName} 視窗`,
  'Quick Launcher': '快速啟動器',
  'Always on Top': '視窗置頂',
  'Toggle Navigation': '切換導覽',
  [`About ${distro.productName}`]: `關於 ${distro.productName}`,
  'CodeBuddy Documentation': 'CodeBuddy 使用說明',
  'Report a CodeBuddy Issue': '回報 CodeBuddy 問題',
  Undo: '復原',
  Redo: '重做',
  'Select All': '全選',
  Delete: '刪除',
  Speech: '語音',
  Reload: '重新載入',
  'Force Reload': '強制重新載入',
  'Toggle Developer Tools': '切換開發人員工具',
  'Actual Size': '實際大小',
  'Reset Zoom': '重設縮放',
  'Zoom In': '放大',
  'Zoom Out': '縮小',
  'Toggle Full Screen': '切換全螢幕',
  'Toggle Fullscreen': '切換全螢幕',
  Minimize: '最小化',
  Close: '關閉',
  'Close Window': '關閉視窗',
  Quit: '結束',
  Exit: '結束',
  'Bring All to Front': '全部移到最前方',
  'Emoji & Symbols': '表情符號與符號',
  'Start Dictation…': '開始聽寫…',
  [`Hide ${distro.productName}`]: `隱藏 ${distro.productName}`,
  'Hide Others': '隱藏其他項目',
  'Show All': '全部顯示',
  Services: '服務',
};

function detectMenuLocale(): string {
  return getConfiguredGooseLocale() ?? 'en';
}

function menuT(label: string): string {
  // Normalize underscores to hyphens so POSIX-style tags like "zh_CN" work.
  const lower = detectMenuLocale().replace(/_/g, '-').toLowerCase();
  const isTraditional = /^zh-(hant|tw|hk|mo)\b/.test(lower);
  const isSimplifiedChinese = !isTraditional && (lower === 'zh' || lower.startsWith('zh-'));
  if (isTraditional) {
    return MENU_TRANSLATIONS_ZH_TW[label] ?? label;
  }
  if (isSimplifiedChinese) {
    return MENU_TRANSLATIONS_ZH_CN[label] ?? label;
  }
  return label;
}

function nativeT(english: string, simplifiedChinese: string, traditionalChinese: string): string {
  return selectNativeText(detectMenuLocale(), english, simplifiedChinese, traditionalChinese);
}

/**
 * Recursively translate `label` on every item in the given menu, including nested submenus.
 * Electron's default application menu comes with English labels that are not otherwise
 * configurable, so we post-process them here before calling `Menu.setApplicationMenu`.
 */
function translateMenuLabels(items: MenuItem[]): void {
  for (const item of items) {
    if (item.label) {
      const translated = menuT(item.label);
      if (translated !== item.label) {
        // MenuItem.label is a writable property on the main-process side, even though
        // the TS type sometimes claims otherwise. Cast through unknown for safety.
        (item as unknown as { label: string }).label = translated;
      }
    }
    if (item.submenu && item.submenu.items) {
      translateMenuLabels(item.submenu.items);
    }
  }
}

// Settings management
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const validLanguageSettings = new Set<Settings['language']>([
  'system',
  'en',
  'es',
  'fr',
  'de',
  'it',
  'pt',
  'id',
  'ms',
  'vi',
  'hi',
  'ja',
  'ko',
  'ru',
  'tr',
  'zh-CN',
  'zh-TW',
]);

function isValidLanguageSetting(value: unknown): value is Settings['language'] {
  return typeof value === 'string' && validLanguageSettings.has(value as Settings['language']);
}

function getSettings(): Settings {
  if (fsSync.existsSync(SETTINGS_FILE)) {
    let stored: Partial<Settings>;
    try {
      const data = fsSync.readFileSync(SETTINGS_FILE, 'utf8');
      stored = JSON.parse(data) as Partial<Settings>;
    } catch (err) {
      console.error('Failed to read settings.json, using defaults:', err);
      return defaultSettings;
    }
    return {
      ...defaultSettings,
      ...stored,
      ...readTypography(stored),
      externalGoosed: {
        ...defaultSettings.externalGoosed,
        ...(stored.externalGoosed ?? {}),
      },
      keyboardShortcuts: {
        ...defaultSettings.keyboardShortcuts,
        ...(stored.keyboardShortcuts ?? {}),
      },
    };
  }
  return defaultSettings;
}

function updateSettings(modifier: (settings: Settings) => void): void {
  const settings = { ...getSettings() };
  modifier(settings);
  fsSync.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function getConfiguredGooseLocale(): string | undefined {
  const language = getSettings().language;
  if (isValidLanguageSetting(language) && language !== 'system') {
    return language;
  }

  if (process.env.GOOSE_LOCALE) {
    return process.env.GOOSE_LOCALE;
  }

  try {
    return app.isReady() ? app.getSystemLocale() || undefined : undefined;
  } catch {
    return undefined;
  }
}

async function configureProxy() {
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || '';

  const proxyUrl = httpsProxy || httpProxy;

  if (proxyUrl) {
    console.log('[Main] Configuring proxy');
    await session.defaultSession.setProxy({
      proxyRules: proxyUrl,
      proxyBypassRules: noProxy,
    });
    console.log('[Main] Proxy configured successfully');
  }
}

if (started) app.quit();

// Certificate trust for active backend leases. Renderer requests and
// main-process net.fetch both pin to the exact cert fingerprint. Each backend
// lease owns a trust record so old windows keep working after settings change.
interface BackendCertificateTrust {
  hostname: string;
  fingerprint: string | null;
}

interface BackendCertificateTrustRegistration {
  trust: BackendCertificateTrust;
  release: () => void;
}

const trustedBackendCertificates = new Set<BackendCertificateTrust>();

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase();
}

function normalizeFingerprint(fp: string): string {
  if (fp.startsWith('sha256/')) {
    const b64 = fp.slice('sha256/'.length);
    const buf = Buffer.from(b64, 'base64');
    return Array.from(buf)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(':')
      .toUpperCase();
  }
  return fp.toUpperCase();
}

function trustBackendCertificate(
  hostname: string,
  fingerprint: string | null
): BackendCertificateTrustRegistration {
  const trust: BackendCertificateTrust = {
    hostname: normalizeHostname(hostname),
    fingerprint: fingerprint ? normalizeFingerprint(fingerprint) : null,
  };
  trustedBackendCertificates.add(trust);
  return {
    trust,
    release: () => {
      trustedBackendCertificates.delete(trust);
    },
  };
}

function getBackendCertificateTrusts(hostname: string): BackendCertificateTrust[] {
  const normalizedHostname = normalizeHostname(hostname);
  return [...trustedBackendCertificates].filter((trust) => trust.hostname === normalizedHostname);
}

function verifyBackendCertificate(hostname: string, fingerprint: string): boolean {
  const normalizedFingerprint = normalizeFingerprint(fingerprint);
  const trusts = getBackendCertificateTrusts(hostname);
  if (trusts.length === 0) {
    return false;
  }

  if (trusts.some((trust) => trust.fingerprint === normalizedFingerprint)) {
    return true;
  }

  const tofuTrust = trusts.find((trust) => trust.fingerprint === null);
  if (tofuTrust) {
    // TOFU: pin the certificate from the first successful handshake.
    tofuTrust.fingerprint = normalizedFingerprint;
    return true;
  }

  return false;
}

function isTrustedHost(hostname: string): boolean {
  return getBackendCertificateTrusts(hostname).length > 0;
}

// Renderer requests: pin to the exact cert once known.
app.on('certificate-error', (event, _webContents, url, _error, certificate, callback) => {
  const parsed = new URL(url);
  if (!isTrustedHost(parsed.hostname)) {
    callback(false);
    return;
  }

  event.preventDefault();
  callback(
    verifyBackendCertificate(parsed.hostname, getBackendCertificateSha256Fingerprint(certificate))
  );
});

let pendingNetworkConsent: Promise<boolean> | undefined;

function requestNetworkAccess(event: IpcMainInvokeEvent): Promise<boolean> {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || event.senderFrame !== event.sender.mainFrame || !applicationWindows().includes(owner))
    return Promise.resolve(false);
  if (getSettings().networkAccessAllowed === true) return Promise.resolve(true);
  return pendingNetworkConsent ??= dialog.showMessageBox(owner, {
    type: 'question',
    title: 'CodeBuddy',
    message: nativeT('Allow CodeBuddy to access the network?', '允许 CodeBuddy 访问网络吗？', '允許 CodeBuddy 存取網路嗎？'),
    detail: nativeT(
      'This action needs a network connection. Allow access for online models, connected tools and updates, or cancel this action and keep using CodeBuddy.',
      '此操作需要联网。允许后，在线模型、联网工具和更新可使用网络；选择「取消」可继续使用 CodeBuddy。',
      '此操作需要連網。允許後，線上模型、連網工具和更新可使用網路；選擇「取消」可繼續使用 CodeBuddy。'
    ),
    buttons: [nativeT('Allow', '允许', '允許'), nativeT('Cancel', '取消', '取消')],
    defaultId: 1, cancelId: 1, noLink: true,
  }).then(({ response }) => {
    if (response !== 0) return false;
    updateSettings(settings => { settings.networkAccessAllowed = true; });
    for (const win of applicationWindows()) win.webContents.send('network-access-granted');
    return true;
  }).catch(error => {
    log.error('Network consent failed', error);
    dialog.showErrorBox('CodeBuddy', nativeT('Could not save network permission.', '无法保存联网授权。', '無法儲存連網授權。'));
    return false;
  }).finally(() => { pendingNetworkConsent = undefined; });
}

ipcMain.handle('request-network-access', requestNetworkAccess);

app.whenReady().then(() => {
  if (started || !gotTheLock) return;
  appConfig.GOOSE_LOCALE = getConfiguredGooseLocale();
  registerDesktopControl();
});

// Main-process net.fetch: pin to the exact cert once known.
function installBackendCertificateVerification(targetSession: Session): void {
  targetSession.setCertificateVerifyProc((request, callback) => {
    if (!isTrustedHost(request.hostname)) {
      callback(-3);
      return;
    }

    const match = verifyBackendCertificate(
      request.hostname,
      getBackendCertificateSha256Fingerprint(request.certificate)
    );
    callback(match ? 0 : -2);
  });
}

app.whenReady().then(() => {
  installBackendCertificateVerification(session.defaultSession);
  installBackendCertificateVerification(session.fromPartition(localProfilePartition));
  // Chromium captures protocol handlers when the renderer loads. Register before
  // creating windows; lazy registration at the first file IPC misses a cold load.
  registerWorkspaceMediaSession(session.fromPartition(localProfilePartition));
});

if (harnessPreview && process.env.CODEBUDDY_PREVIEW_DEVTOOLS_PORT) {
  const debugPort = Number(process.env.CODEBUDDY_PREVIEW_DEVTOOLS_PORT);
  if (!Number.isInteger(debugPort) || debugPort < 1 || debugPort > 65535) {
    throw new Error('CODEBUDDY_PREVIEW_DEVTOOLS_PORT must be a valid TCP port');
  }
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', String(debugPort));
} else if (!harnessPreview && process.env.ENABLE_PLAYWRIGHT) {
  const debugPort = process.env.PLAYWRIGHT_DEBUG_PORT || '9222';
  console.log(`[Main] Enabling Playwright remote debugging on port ${debugPort}`);
  app.commandLine.appendSwitch('remote-debugging-port', debugPort);
}

// Lifecycle probes run unpackaged builds beside a real installation and must not
// replace that installation's protocol handler. Normal launches still register.
// Inno registers codebuddy:// for the selected scope. Registering it again
// from Electron would shadow the machine-wide handler in the user's registry.
const innoInstallation =
  process.platform === 'win32' &&
  app.isPackaged &&
  fsSync.existsSync(path.join(path.dirname(process.execPath), 'unins000.exe'));
const protocolRegistrationEnabled =
  !innoInstallation && process.env.CODEBUDDY_DISABLE_PROTOCOL_REGISTRATION !== 'true';

// In development mode, force registration as the default protocol client.
// In production, register normally unless an isolated lifecycle probe opted out.
if (protocolRegistrationEnabled && MAIN_WINDOW_VITE_DEV_SERVER_URL) {
  // Development mode - force registration
  console.log(`[Main] Development mode: registering ${PRIMARY_DEEP_LINK_PREFIX}`);
  app.setAsDefaultProtocolClient(distro.protocol);

  if (process.platform === 'darwin') {
    try {
      // Reset the default handler to ensure dev version takes precedence
      spawn(
        'open',
        ['-a', process.execPath, '--args', '--reset-protocol-handler', distro.protocol],
        {
          detached: true,
          stdio: 'ignore',
        }
      );
    } catch {
      console.warn('[Main] Could not reset protocol handler');
    }
  }
} else if (protocolRegistrationEnabled) {
  // Production mode - normal registration
  app.setAsDefaultProtocolClient(distro.protocol);
}

// Apply single instance lock on Windows and Linux where it's needed for deep links
// macOS uses the 'open-url' event instead
let gotTheLock = true;
let openUrlHandledLaunch = false;
if (process.platform !== 'darwin') {
  gotTheLock = app.requestSingleInstanceLock();

  if (!gotTheLock) {
    log.info('Desktop startup handed off to an existing instance');
    app.quit();
  } else {
    app.on('second-instance', (_event, commandLine) => {
      const protocolUrl = findSupportedDeepLink(commandLine);
      if (protocolUrl) {
        const parsedUrl = new URL(protocolUrl);
        // If it's a bot/recipe URL, handle it directly by creating a new window
        if (parsedUrl.hostname === 'bot' || parsedUrl.hostname === 'recipe') {
          app.whenReady().then(async () => {
            const deeplinkData = parseRecipeDeeplink(protocolUrl);
            const scheduledJobId = parsedUrl.searchParams.get('scheduledJob');

            await createChat(app, {
              recipeDeeplink: deeplinkData?.config,
              scheduledJobId: scheduledJobId || undefined,
              recipeParameters: deeplinkData?.parameters,
            });
          });
          return; // Skip the rest of the handler
        }

        // Handle new-session URL by creating a fresh chat window
        if (parsedUrl.hostname === 'new-session') {
          app.whenReady().then(async () => {
            const prompt = parsedUrl.searchParams.get('prompt') || undefined;
            await createChat(app, {
              initialMessage: prompt,
              initialMessageNoAutoSubmit: prompt !== undefined,
            });
          });
          return;
        }

        if (parsedUrl.hostname === 'resume') {
          app.whenReady().then(async () => {
            await createResumeChatWindow(parsedUrl);
          });
          return;
        }

        // For non-bot URLs, continue with normal handling
        handleProtocolUrl(protocolUrl, parsedUrl);
      }

      // Only focus existing windows for non-bot/recipe URLs
      const existingWindows = applicationWindows();
      if (existingWindows.length > 0) {
        const mainWindow = existingWindows[0];
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }
        mainWindow.focus();
      }
    });
  }

  // Handle protocol URLs on Windows and Linux startup
  const protocolUrl = findSupportedDeepLink(process.argv);
  if (protocolUrl) {
    app.whenReady().then(async () => {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(protocolUrl);
      } catch (error) {
        log.warn('[Main] Ignoring invalid startup protocol URL:', errorMessage(error));
        return;
      }

      openUrlHandledLaunch = true;
      try {
        await handleProtocolUrl(protocolUrl, parsedUrl);
      } catch (error) {
        log.error('[Main] Failed to handle startup protocol URL:', errorMessage(error));
        if (applicationWindows().length === 0) {
          const { dirPath } = parseArgs();
          await createNewWindow(app, dirPath);
        }
      }
    });
  }
}

const pendingDeepLinks = new Map<number, string>();

function queuePendingDeepLink(windowId: number, url: string): void {
  if (pendingDeepLinks.get(windowId) === url) {
    return;
  }
  pendingDeepLinks.set(windowId, url);
}

const reactReadyWindows = new Set<number>();

const DEEPLINK_BURST_DEDUP_MS = 2000;
const recentSessionDeepLinkSends = new Map<string, number>();

function pruneExpiredSessionDeepLinkSends(now: number): void {
  for (const [url, sentAt] of recentSessionDeepLinkSends) {
    if (now - sentAt >= DEEPLINK_BURST_DEDUP_MS) {
      recentSessionDeepLinkSends.delete(url);
    }
  }
}

function isBurstDuplicateSessionDeepLink(url: string): boolean {
  const now = Date.now();
  pruneExpiredSessionDeepLinkSends(now);
  const sentAt = recentSessionDeepLinkSends.get(url);
  return sentAt !== undefined && now - sentAt < DEEPLINK_BURST_DEDUP_MS;
}

function recordSessionDeepLinkSend(url: string): void {
  const now = Date.now();
  recentSessionDeepLinkSends.set(url, now);
  pruneExpiredSessionDeepLinkSends(now);
}

function sendOpenSharedSession(window: BrowserWindow, url: string): void {
  if (isBurstDuplicateSessionDeepLink(url)) {
    log.info('[Main] Ignoring burst duplicate session deep link');
    return;
  }
  recordSessionDeepLinkSend(url);
  window.webContents.send('open-shared-session', url);
}

function deliverExtensionOrSessionDeepLink(
  url: string,
  parsedUrl: URL,
  targetWindow: BrowserWindow
): void {
  if (!reactReadyWindows.has(targetWindow.id) || targetWindow.webContents.isLoadingMainFrame()) {
    queuePendingDeepLink(targetWindow.id, url);
    return;
  }

  if (parsedUrl.hostname === 'extension') {
    targetWindow.webContents.send('add-extension', url);
  } else if (parsedUrl.hostname === 'sessions') {
    sendOpenSharedSession(targetWindow, url);
  }
}

function getResumeSessionId(parsedUrl: URL): string | null {
  try {
    const sessionId = decodeURIComponent(parsedUrl.pathname.replace(/^\/+/, '')).trim();
    return sessionId || null;
  } catch {
    return null;
  }
}

async function createResumeChatWindow(parsedUrl: URL, dir?: string): Promise<boolean> {
  const resumeSessionId = getResumeSessionId(parsedUrl);
  if (!resumeSessionId) {
    log.warn('[Main] Ignoring resume deep link without a session id');
    return false;
  }

  await createChat(app, { dir, resumeSessionId });
  return true;
}

async function handleProtocolUrl(url: string, parsedUrl: URL) {
  if (!url) return;

  if (parsedUrl.hostname === 'new-session') {
    const prompt = parsedUrl.searchParams.get('prompt') || undefined;
    await createChat(app, {
      initialMessage: prompt,
      initialMessageNoAutoSubmit: prompt !== undefined,
    });
    return;
  } else if (parsedUrl.hostname === 'resume') {
    await createResumeChatWindow(parsedUrl);
    return;
  } else if (parsedUrl.hostname === 'bot' || parsedUrl.hostname === 'recipe') {
    const existingWindows = applicationWindows();
    const targetWindow = existingWindows.length > 0 ? existingWindows[0] : await createChat(app);
    if (!targetWindow) return;
    await processProtocolUrl(url, parsedUrl, targetWindow);
  } else {
    const existingWindows = applicationWindows();
    let targetWindow: BrowserWindow | undefined;
    if (existingWindows.length > 0) {
      targetWindow = existingWindows[0];
      if (targetWindow.isMinimized()) {
        targetWindow.restore();
      }
      targetWindow.focus();
    } else {
      targetWindow = await createChat(app);
    }

    if (!targetWindow) return;

    if (targetWindow.webContents.isLoadingMainFrame()) {
      queuePendingDeepLink(targetWindow.id, url);
    } else {
      await processProtocolUrl(url, parsedUrl, targetWindow);
    }
  }
}

async function processProtocolUrl(url: string, parsedUrl: URL, window: BrowserWindow) {
  if (parsedUrl.hostname === 'extension') {
    window.webContents.send('add-extension', url);
  } else if (parsedUrl.hostname === 'sessions') {
    sendOpenSharedSession(window, url);
  } else if (parsedUrl.hostname === 'bot' || parsedUrl.hostname === 'recipe') {
    const deeplinkData = parseRecipeDeeplink(url);
    const scheduledJobId = parsedUrl.searchParams.get('scheduledJob');

    await createChat(app, {
      recipeDeeplink: deeplinkData?.config,
      scheduledJobId: scheduledJobId || undefined,
      recipeParameters: deeplinkData?.parameters,
    });
  }
}

app.on('open-url', async (_event, url) => {
  if (process.platform !== 'win32') {
    const parsedUrl = new URL(url);

    log.info(
      '[Main] Received open-url event:',
      url.includes('key=') ? url.replace(/key=[^&]+/, 'key=REDACTED') : url
    );

    await app.whenReady();

    // Handle new-session URL by creating a fresh chat window
    if (parsedUrl.hostname === 'new-session') {
      log.info('[Main] Detected new-session URL, creating new chat window');
      openUrlHandledLaunch = true;
      const prompt = parsedUrl.searchParams.get('prompt') || undefined;
      await createChat(app, {
        initialMessage: prompt,
        initialMessageNoAutoSubmit: prompt !== undefined,
      });
      return;
    }

    if (parsedUrl.hostname === 'resume') {
      log.info('[Main] Detected resume URL, creating session resume window');
      openUrlHandledLaunch = await createResumeChatWindow(parsedUrl);
      return;
    }

    // Handle bot/recipe URLs by directly creating a new window
    if (parsedUrl.hostname === 'bot' || parsedUrl.hostname === 'recipe') {
      log.info('[Main] Detected bot/recipe URL, creating new chat window');
      openUrlHandledLaunch = true;
      const deeplinkData = parseRecipeDeeplink(url);
      const scheduledJobId = parsedUrl.searchParams.get('scheduledJob');

      await createChat(app, {
        recipeDeeplink: deeplinkData?.config,
        scheduledJobId: scheduledJobId || undefined,
        recipeParameters: deeplinkData?.parameters,
      });
      return;
    }

    // For extension/session URLs, send to existing window or store pending for new one
    const existingWindows = applicationWindows();
    if (existingWindows.length > 0) {
      const targetWindow = existingWindows[0];
      if (targetWindow.isMinimized()) targetWindow.restore();
      targetWindow.focus();
      if (parsedUrl.hostname === 'extension' || parsedUrl.hostname === 'sessions') {
        deliverExtensionOrSessionDeepLink(url, parsedUrl, targetWindow);
      }
    } else {
      openUrlHandledLaunch = true;
      const newWindow = await createChat(app);
      if (!newWindow) return;
      queuePendingDeepLink(newWindow.id, url);
    }
  }
});

// Handle macOS drag-and-drop onto dock icon
app.on('will-finish-launching', () => {
  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({
      applicationName: distro.productName,
      applicationVersion: app.getVersion(),
    });
  }
});

// Register before ready: Finder and Dock can deliver one event per file during launch.
const fileOpenQueue = new FileOpenQueue(handleFileOpen, (error) => {
  log.error('[Main] Failed to handle file open:', errorMessage(error));
});
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  fileOpenQueue.enqueue(filePath);
});

async function handleFileOpen(filePath: string): Promise<boolean> {
  try {
    if (!filePath || typeof filePath !== 'string') {
      return false;
    }

    const stats = fsSync.statSync(filePath);
    if (!stats.isFile() && !stats.isDirectory()) {
      throw new Error('The opened item is not a file or directory');
    }
    let targetDir = filePath;

    // If it's a file, use its parent directory
    if (stats.isFile()) {
      targetDir = path.dirname(filePath);
    }

    const targetWindow = await openDirectoryInCurrentWindow(targetDir);

    if (targetWindow) {
      targetWindow.show();
      targetWindow.focus();
      targetWindow.moveTop();
      addRecentDir(targetDir);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Failed to handle file open:', error);

    // Show user-friendly error notification
    new Notification({
      title: distro.productName,
      body: nativeT(
        `Could not open directory: ${path.basename(filePath)}`,
        `未能打开目录：${path.basename(filePath)}`,
        `未能開啟目錄：${path.basename(filePath)}`
      ),
    }).show();
    return false;
  }
}

declare var MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare var MAIN_WINDOW_VITE_NAME: string;

function getAppUrl(): URL {
  return MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
    : pathToFileURL(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
}

// Parse command line arguments
const parseArgs = () => {
  // Remove first two elements in dev mode (electron and script path)
  const args = app.isPackaged ? process.argv : process.argv.slice(2);
  const dirPath = resolveStartupDirectory(args, process.env.GOOSE_WORKING_DIR);

  return { dirPath };
};

interface BundledConfig {
  defaultProvider?: string;
  defaultModel?: string;
  predefinedModels?: string;
  version?: string;
}

const getBundledConfig = (): BundledConfig => {
  //{env-macro-start}//
  //needed when goose is bundled for a specific provider
  //{env-macro-end}//
  return {
    defaultProvider: process.env.GOOSE_DEFAULT_PROVIDER,
    defaultModel: process.env.GOOSE_DEFAULT_MODEL,
    predefinedModels: process.env.GOOSE_PREDEFINED_MODELS,
    version: process.env.GOOSE_VERSION,
  };
};

const { defaultProvider, defaultModel, predefinedModels, version } = getBundledConfig();

const GENERATED_SECRET = crypto.randomBytes(32).toString('hex');

interface ExternalBackend {
  source: 'env' | 'settings';
  url: string;
  secret: string;
  certFingerprint?: string;
}

const getExternalBackendUrlFromEnv = (): string | null => {
  const externalBackendEnabled =
    process.env.CODEBUDDY_EXTERNAL_BACKEND ?? process.env.GOOSE_EXTERNAL_BACKEND;
  if (!externalBackendEnabled) {
    return null;
  }

  const configuredUrl = (
    process.env.CODEBUDDY_EXTERNAL_BACKEND_URL ?? process.env.GOOSE_EXTERNAL_BACKEND_URL
  )?.trim();
  if (configuredUrl) {
    return configuredUrl;
  }

  const port = process.env.CODEBUDDY_PORT ?? process.env.GOOSE_PORT ?? '3000';
  return `http://127.0.0.1:${port}`;
};

const getExternalBackendFromEnv = (): ExternalBackend | null => {
  const url = getExternalBackendUrlFromEnv();
  if (!url) {
    return null;
  }

  const secret = process.env.CODEBUDDY_SERVER__SECRET_KEY ?? process.env.GOOSE_SERVER__SECRET_KEY;
  if (!secret) {
    throw new Error(
      'CODEBUDDY_SERVER__SECRET_KEY must be set when using CODEBUDDY_EXTERNAL_BACKEND. ' +
        'Set it to the same value on both the server and the desktop client.'
    );
  }

  return {
    source: 'env',
    url,
    secret,
  };
};

const getServerSecret = (settings: Settings): string => {
  if (settings.externalGoosed?.enabled && settings.externalGoosed.secret) {
    return settings.externalGoosed.secret;
  }
  return GENERATED_SECRET;
};

const getActiveExternalBackend = (settings: Settings): ExternalBackend | null => {
  const envBackend = getExternalBackendFromEnv();
  if (envBackend) {
    return envBackend;
  }

  if (settings.externalGoosed?.enabled && settings.externalGoosed.url) {
    return {
      source: 'settings',
      url: settings.externalGoosed.url,
      secret: getServerSecret(settings),
      certFingerprint: settings.externalGoosed.certFingerprint,
    };
  }

  return null;
};

const getExternalBackendForCsp = (settings: Settings) => {
  const envUrl = getExternalBackendUrlFromEnv();
  if (!envUrl) {
    return settings.externalGoosed;
  }

  return {
    ...settings.externalGoosed,
    enabled: true,
    url: envUrl,
  };
};

let appConfig = {
  GOOSE_DEFAULT_PROVIDER: defaultProvider,
  GOOSE_DEFAULT_MODEL: defaultModel,
  GOOSE_PREDEFINED_MODELS: predefinedModels,
  GOOSE_PATH_ROOT: sanitizeGoosePathRoot(process.env),
  CODEBUDDY_HOME: storagePaths.homeDir,
  CODEBUDDY_WORKSPACE_ROOT: process.env.CODEBUDDY_WORKSPACE_ROOT,
  GOOSE_WORKING_DIR: '',
  // Start with the env-var override; the OS region locale is filled in after app.ready
  // (see updateLocaleFromSystem below) since getSystemLocale() cannot be called earlier.
  GOOSE_LOCALE: process.env.GOOSE_LOCALE || undefined,
  // If GOOSE_ALLOWLIST_WARNING env var is not set, defaults to false (strict blocking mode)
  GOOSE_ALLOWLIST_WARNING: process.env.GOOSE_ALLOWLIST_WARNING === 'true',
  GOOSE_DISABLE_NOSTR_SHARING: process.env.GOOSE_DISABLE_NOSTR_SHARING === 'true',
};

const windowMap = new Map<number, BrowserWindow>();
const appWindows = new Map<string, BrowserWindow>();

const pendingWindowBindings = new Map<number, Promise<void>>();
const gooseServeLeases = new GooseServeLeaseRegistry(log);

const taskWakelock = new TaskWakelock(powerSaveBlocker);
// Track pending initial messages per window
const pendingInitialMessages = new Map<
  number,
  { message: string; noAutoSubmit: boolean; workingDir?: string; draftOnly?: boolean; images?: import('./types/message').ImageData[] }
>();

interface CreateChatOptions {
  initialMessage?: string;
  initialMessageNoAutoSubmit?: boolean;
  initialImages?: import('./types/message').ImageData[];
  settingsSection?: string;
  dir?: string;
  resumeSessionId?: string;
  viewType?: string;
  recipeDeeplink?: string;
  recipeId?: string;
  workspaceMode?: 'code' | 'codepro';
  workspaceBinding?: 'unbound';
  scheduledJobId?: string;
  recipeParameters?: Record<string, string>;
}

const createChat = async (
  app: App,
  options: CreateChatOptions = {}
): Promise<BrowserWindow | undefined> => {
  const {
    initialMessage,
    initialMessageNoAutoSubmit,
    initialImages,
    settingsSection,
    dir,
    resumeSessionId,
    viewType,
    recipeDeeplink,
    recipeId,
    workspaceMode,
    workspaceBinding,
    scheduledJobId,
    recipeParameters,
  } = options;
  const settings = getSettings();

  // The packaged renderer can mount while its private loopback endpoint is starting.
  // External backends still use their existing certificate and connectivity checks.
  const runtime = harnessPackaged ? packagedStartup() : undefined;
  let externalBackend: ExternalBackend | null;
  try {
    externalBackend = runtime ? null : getActiveExternalBackend(settings);
  } catch (error) {
    dialog.showMessageBoxSync({
      type: 'error',
      title: nativeT('External Backend Misconfigured', '外部后端配置错误', '外部後端設定錯誤'),
      message: nativeT(
        'The external backend environment is invalid.',
        '外部后端环境配置无效。',
        '外部後端環境設定無效。'
      ),
      detail: errorMessage(error),
      buttons: [menuT('Quit')],
    });
    app.quit();
    return;
  }

  if (externalBackend?.certFingerprint) {
    const url = externalBackend.url;
    const usesHttps = (() => {
      try {
        return new URL(url).protocol === 'https:';
      } catch {
        return false;
      }
    })();

    if (!usesHttps) {
      const response = dialog.showMessageBoxSync({
        type: 'error',
        title: nativeT('External Backend Misconfigured', '外部后端配置错误', '外部後端設定錯誤'),
        message: nativeT(
          'Certificate fingerprint requires an HTTPS external backend URL.',
          '配置证书指纹时，外部后端地址必须使用 HTTPS。',
          '設定憑證指紋時，外部後端位址必須使用 HTTPS。'
        ),
        detail: nativeT(
          'Use an https:// URL or remove the configured certificate fingerprint.',
          '请使用 https:// 地址，或删除已配置的证书指纹。',
          '請使用 https:// 位址，或刪除已設定的憑證指紋。'
        ),
        buttons: [
          nativeT('Disable External Backend & Retry', '禁用外部后端并重试', '停用外部後端並重試'),
          menuT('Quit'),
        ],
        defaultId: 0,
        cancelId: 1,
      });

      if (response === 0) {
        updateSettings((s) => {
          if (s.externalGoosed) {
            s.externalGoosed.enabled = false;
          }
        });
        return createChat(app, options);
      }

      app.quit();
      return;
    }
  }

  const serverSecret = externalBackend ? externalBackend.secret : GENERATED_SECRET;
  // New chats must not fall back to the home directory: prefer the most recent
  // project, otherwise leave the working dir unbound for the backend's own
  // process-cwd fallback instead of pinning sessions to the C: drive.
  let workingDir = dir || loadRecentDirs()[0] || '';
  let gooseServeLease: GooseServeLease | null = null;

  if (externalBackend) {
    let externalCertificateTrust: BackendCertificateTrustRegistration | null = null;

    try {
      const externalBaseUrl = normalizeAcpHttpBaseUrl(externalBackend.url);
      const externalBase = new URL(externalBaseUrl);
      if (externalBase.protocol === 'https:') {
        externalCertificateTrust = trustBackendCertificate(
          externalBase.hostname,
          externalBackend.certFingerprint ?? null
        );
      }

      const externalBackendReady = await checkBackendStatus({
        baseUrl: externalBaseUrl,
        serverSecret,
        fetch: net.fetch as unknown as typeof globalThis.fetch,
      });
      if (!externalBackendReady) {
        externalCertificateTrust?.release();
        const canDisableExternalBackend = externalBackend.source === 'settings';
        const response = dialog.showMessageBoxSync({
          type: 'error',
          title: nativeT('External Backend Unreachable', '无法连接外部后端', '無法連線外部後端'),
          message: nativeT(
            `Could not connect to external backend at ${externalBaseUrl}`,
            `无法连接到外部后端：${externalBaseUrl}`,
            `無法連線到外部後端：${externalBaseUrl}`
          ),
          detail: nativeT(
            'The external backend must be running and the configured secret must match CODEBUDDY_SERVER__SECRET_KEY on the server.',
            '请确认外部后端正在运行，并且配置的密钥与服务器上的 CODEBUDDY_SERVER__SECRET_KEY 一致。',
            '請確認外部後端正在執行，且設定的密鑰與伺服器上的 CODEBUDDY_SERVER__SECRET_KEY 一致。'
          ),
          buttons: canDisableExternalBackend
            ? [
                nativeT(
                  'Disable External Backend & Retry',
                  '禁用外部后端并重试',
                  '停用外部後端並重試'
                ),
                menuT('Quit'),
              ]
            : [menuT('Quit')],
          defaultId: 0,
          cancelId: canDisableExternalBackend ? 1 : 0,
        });

        if (canDisableExternalBackend && response === 0) {
          updateSettings((s) => {
            if (s.externalGoosed) {
              s.externalGoosed.enabled = false;
            }
          });
          return createChat(app, options);
        }

        app.quit();
        return;
      }

      const leaseCertificateTrust = externalCertificateTrust;
      externalCertificateTrust = null;
      gooseServeLease = gooseServeLeases.createExternal(
        acpWebSocketUrlFromHttpBase(externalBaseUrl, serverSecret),
        serverSecret,
        leaseCertificateTrust ? async () => leaseCertificateTrust.release() : undefined
      );
    } catch (error) {
      externalCertificateTrust?.release();
      log.error('External ACP backend is misconfigured', error);
      const canDisableExternalBackend = externalBackend.source === 'settings';
      const response = dialog.showMessageBoxSync({
        type: 'error',
        title: nativeT('External Backend Misconfigured', '外部后端配置错误', '外部後端設定錯誤'),
        message: nativeT(
          'The external backend URL is invalid.',
          '外部后端地址无效。',
          '外部後端位址無效。'
        ),
        detail: errorMessage(error),
        buttons: canDisableExternalBackend
          ? [
              nativeT(
                'Disable External Backend & Retry',
                '禁用外部后端并重试',
                '停用外部後端並重試'
              ),
              menuT('Quit'),
            ]
          : [menuT('Quit')],
        defaultId: 0,
        cancelId: canDisableExternalBackend ? 1 : 0,
      });

      if (canDisableExternalBackend && response === 0) {
        updateSettings((s) => {
          if (s.externalGoosed) {
            s.externalGoosed.enabled = false;
          }
        });
        return createChat(app, options);
      }

      app.quit();
      return;
    }
  } else if (!runtime) {
    log.error('Harness runtime is missing. Use start-preview.ps1 or the Harness installer.');
    dialog.showMessageBoxSync({
      type: 'error',
      title: 'CodeBuddy',
      message: nativeT(
        'CodeBuddy runtime is not connected.',
        'CodeBuddy 运行时尚未连接。',
        'CodeBuddy 執行環境尚未連線。'
      ),
      detail: nativeT(
        'Use start-preview.ps1 for development or reinstall CodeBuddy.',
        '开发请使用 start-preview.ps1，安装版请重新安装 CodeBuddy。',
        '開發請使用 start-preview.ps1，安裝版請重新安裝 CodeBuddy。'
      ),
      buttons: [nativeT('OK', '确定', '確定')],
    });
    app.quit();
    return;
  }

  const cleanupUnregisteredGooseServeLease = async () => {
    if (!gooseServeLease) {
      return;
    }

    const lease = gooseServeLease;
    gooseServeLease = null;
    await gooseServeLeases.cleanupLease(lease);
  };

  let mainWindowState: ReturnType<typeof windowStateKeeper>;
  let mainWindow: BrowserWindow;
  try {
    mainWindowState = windowStateKeeper({
      defaultWidth: 1280,
      defaultHeight: 720,
    });

    mainWindow = new BrowserWindow({
      show: false,
      titleBarStyle: process.platform === 'darwin' || process.platform === 'win32' ? 'hidden' : 'default',
      ...(process.platform === 'win32' ? {
        titleBarOverlay: { color: '#f6f7f9', symbolColor: '#505867', height: 36 },
        autoHideMenuBar: true,
      } : {}),
      trafficLightPosition: process.platform === 'darwin' ? { x: 20, y: 16 } : undefined,
      vibrancy: process.platform === 'darwin' ? 'window' : undefined,
      frame: process.platform !== 'darwin',
      // windowStateKeeper persists the outer window bounds (getBounds), so the
      // window must be restored by outer bounds too. With useContentSize the saved
      // outer height is reapplied as the content height, growing the window by the
      // frame height on every launch on framed platforms (#9363).
      x: mainWindowState.x,
      y: mainWindowState.y,
      width: mainWindowState.width,
      height: mainWindowState.height,
      minWidth: 480,
      minHeight: 600,
      resizable: true,
      icon: path.join(
        app.isPackaged ? process.resourcesPath : path.join(process.cwd(), 'src'),
        'images',
        windowIconFileName(process.platform)
      ),
      webPreferences: {
        spellcheck: settings.spellcheckEnabled ?? true,
        zoomFactor: settings.windowZoom / 100,
        preload: path.join(__dirname, 'preload.js'),
        webSecurity: true,
        nodeIntegration: false,
        contextIsolation: true,
        additionalArguments: [
          JSON.stringify({
            ...appConfig,
            WINDOW_TITLEBAR_OVERLAY: process.platform === 'win32',
            GOOSE_LOCALE: getConfiguredGooseLocale(),
            GOOSE_WORKING_DIR: workingDir,
            REQUEST_DIR: dir,
            GOOSE_VERSION: version,
            recipeDeeplink: recipeDeeplink,
            recipeId: recipeId,
            workspaceMode,
            workspaceBinding,
            recipeParameters: recipeParameters,
            scheduledJobId: scheduledJobId,
            SECURITY_ML_MODEL_MAPPING: process.env.SECURITY_ML_MODEL_MAPPING,
            SECURITY_PROMPT_ENABLED_OVERRIDE: process.env.SECURITY_PROMPT_ENABLED_OVERRIDE,
            SECURITY_COMMAND_CLASSIFIER_ENABLED_OVERRIDE:
              process.env.SECURITY_COMMAND_CLASSIFIER_ENABLED_OVERRIDE,
          }),
        ],
        partition: localProfilePartition,
      },
    });
  } catch (error) {
    await cleanupUnregisteredGooseServeLease();
    throw error;
  }

  maintainVisibleWindowFrames(mainWindow);
  registerMainWindowRecovery(mainWindow, nativeT);

  if (process.platform === 'win32') {
    mainWindow.setMenuBarVisibility(false);
    // Window icons alone do not identify the taskbar group (notably in Forge).
    // https://www.electronjs.org/docs/latest/api/base-window#winsetappdetailsoptions-windows
    mainWindow.setAppDetails({
      appId: windowsAppUserModelId(app.isPackaged),
      appIconPath: path.join(
        app.isPackaged ? process.resourcesPath : path.join(process.cwd(), 'src'),
        'images',
        'icon.ico'
      ),
      appIconIndex: 0,
    });
  }

  if (runtime) {
    const id = mainWindow.id;
    const binding = runtime.then(({ service }) => {
      if (!mainWindow.isDestroyed()) {
        gooseServeLeases.attachWindow(id, gooseServeLeases.createExternal(
          acpWebSocketUrlFromHttpBase(service.url, service.secret), service.secret
        ));
      }
    });
    pendingWindowBindings.set(id, binding);
    void binding.catch(() => {});
    mainWindow.once('closed', () => {
      pendingWindowBindings.delete(id);
      void gooseServeLeases.releaseWindow(id);
    });
    mainWindow.once('ready-to-show', () => {
      if (!mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show();
    });
  }
  if (gooseServeLease) {
    const lease = gooseServeLease;
    mainWindow.once('closed', () => {
      void gooseServeLeases.releaseWindow(mainWindow.id);
    });
    gooseServeLeases.attachWindow(mainWindow.id, lease);
    gooseServeLease = null;
  }

  if (!app.isPackaged && !harnessPreview && getSettings().networkAccessAllowed === true) {
    installExtension(REACT_DEVELOPER_TOOLS, {
      loadExtensionOptions: { allowFileAccess: true },
      session: mainWindow.webContents.session,
    })
      .then(() => log.info('added react dev tools'))
      .catch((err) => log.info('failed to install react dev tools:', err));
  }

  // Let windowStateKeeper manage the window
  mainWindowState.manage(mainWindow);

  mainWindow.webContents.session.setSpellCheckerLanguages(['en-US', 'en-GB']);
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const menu = new Menu();
    if (params.mediaType === 'image' && params.hasImageContents) {
      menu.append(new MenuItem({
        label: nativeT('Copy image', '复制图片', '複製圖片'),
        click: () => mainWindow.webContents.copyImageAt(params.x, params.y),
      }));
      menu.append(new MenuItem({
        label: nativeT('Save image as…', '图片另存为…', '圖片另存為…'),
        click: () => mainWindow.webContents.downloadURL(params.srcURL),
      }));
      if (params.selectionText || params.isEditable)
        menu.append(new MenuItem({ type: 'separator' }));
    }
    const hasSpellingSuggestions = params.dictionarySuggestions.length > 0 || params.misspelledWord;

    if (hasSpellingSuggestions) {
      for (const suggestion of params.dictionarySuggestions) {
        menu.append(
          new MenuItem({
            label: suggestion,
            click: () => mainWindow.webContents.replaceMisspelling(suggestion),
          })
        );
      }

      if (params.misspelledWord) {
        menu.append(
          new MenuItem({
            label: menuT('Add to dictionary'),
            click: () =>
              mainWindow.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
          })
        );
      }

      if (params.selectionText) {
        menu.append(new MenuItem({ type: 'separator' }));
      }
    }
    if (params.selectionText) {
      menu.append(
        new MenuItem({
          label: menuT('Cut'),
          accelerator: 'CmdOrCtrl+X',
          role: 'cut',
        })
      );
      menu.append(
        new MenuItem({
          label: menuT('Copy'),
          accelerator: 'CmdOrCtrl+C',
          role: 'copy',
        })
      );
    }

    // Only show paste in editable fields (text inputs)
    if (params.isEditable) {
      menu.append(
        new MenuItem({
          label: menuT('Paste'),
          accelerator: 'CmdOrCtrl+V',
          role: 'paste',
        })
      );
    }

    if (menu.items.length > 0) {
      menu.popup();
    }
  });

  // Handle new window creation for links (fallback for any links not handled by onClick)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const protocol = new URL(url).protocol;
      if (BLOCKED_PROTOCOLS.includes(protocol)) {
        return { action: 'deny' };
      }
    } catch {
      return { action: 'deny' };
    }

    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Handle new-window events (alternative approach for external links)
  // Use type assertion for non-standard Electron event
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mainWindow.webContents.on('new-window' as any, function (event: any, url: string) {
    event.preventDefault();
    try {
      const protocol = new URL(url).protocol;
      if (BLOCKED_PROTOCOLS.includes(protocol)) {
        return;
      }
    } catch {
      return;
    }
    shell.openExternal(url);
  });

  const windowId = mainWindow.id;
  const url = getAppUrl();

  let appPath = '/';
  const routeMap: Record<string, string> = {
    chat: '/',
    pair: '/pair',
    'codepro-pair': '/codepro/pair',
    settings: '/settings',
    sessions: '/sessions',
    schedules: '/schedules',
    recipes: '/recipes',
    skills: '/skills',
    permission: '/permission',
    ConfigureProviders: '/configure-providers',
  };

  if (viewType) {
    appPath = routeMap[viewType] || '/';
  }
  if (
    previewInitialRoute &&
    !viewType &&
    !resumeSessionId &&
    !initialMessage &&
    !initialImages?.length &&
    !recipeId &&
    !recipeDeeplink
  ) {
    appPath = previewInitialRoute;
    previewInitialRoute = undefined;
  }
  if (
    appPath === '/' &&
    (recipeDeeplink !== undefined || recipeId !== undefined || initialMessage || initialImages?.length)
  ) {
    appPath = '/pair';
  }

  let searchParams = new URLSearchParams();
  if (packagedHomePending && appPath === '/' && !viewType && !resumeSessionId) {
    packagedHomePending = false;
    searchParams.set('startupHome', '1');
  }
  if (viewType === 'settings' && settingsSection) searchParams.set('section', settingsSection);
  if (resumeSessionId) {
    searchParams.set('resumeSessionId', resumeSessionId);
    if (appPath === '/') {
      appPath = '/pair';
    }
  }
  appPath = resolveCodeProEntryPath(appPath);

  // Goose's react app uses HashRouter, so the path + search params follow a #/
  url.hash = `${appPath}?${searchParams.toString()}`;
  let formattedUrl = formatUrl(url);
  log.info('Opening URL: ', formattedUrl);
  mainWindow.loadURL(formattedUrl);

  // If we have an initial message, store it to send after React is ready
  if (initialMessage || initialImages?.length) {
    pendingInitialMessages.set(mainWindow.id, {
      message: initialMessage ?? '',
      ...(initialImages?.length ? { images: initialImages } : {}),
      noAutoSubmit: Boolean(initialMessageNoAutoSubmit),
      // Carry only the explicitly requested folder, never the recent-project fallback.
      ...(dir?.trim() ? { workingDir: dir } : {}),
    });
  }

  // Set up local keyboard shortcuts that only work when the window is focused
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (process.platform === 'win32') {
      // Keep native command accelerators, but let the compact renderer bar own
      // menu navigation instead of revealing Electron's second menu row.
      mainWindow.webContents.setIgnoreMenuShortcuts(
        (input.alt && !input.control && !input.meta) ||
        (input.key === 'F10' && !input.shift && !input.control && !input.alt)
      );
    }
    // Meta is the Windows key on Windows. Leave capture shortcuts to the OS;
    // Windows/Linux reload uses the native menu's Ctrl+R accelerator.
    if (
      process.platform === 'darwin' &&
      input.type === 'keyDown' &&
      !input.isAutoRepeat &&
      input.key.toLowerCase() === 'r' &&
      input.meta &&
      !input.shift &&
      !input.control &&
      !input.alt
    ) {
      mainWindow.reload();
      event.preventDefault();
    }

    if (input.key === 'i' && input.alt && input.meta) {
      mainWindow.webContents.openDevTools();
      event.preventDefault();
    }
  });

  mainWindow.on('app-command', (e, cmd) => {
    if (cmd === 'browser-backward') {
      mainWindow.webContents.send('mouse-back-button-clicked');
      e.preventDefault();
    }
  });

  const broadcastFullScreenState = () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('fullscreen-change', mainWindow.isFullScreen());
    }
  };
  mainWindow.on('enter-full-screen', broadcastFullScreenState);
  mainWindow.on('leave-full-screen', broadcastFullScreenState);

  // Handle mouse back button (button 3)
  // Use type assertion for non-standard Electron event
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mainWindow.webContents.on('mouse-up' as any, function (_event: any, mouseButton: number) {
    // MouseButton 3 is the back button.
    if (mouseButton === 3) {
      mainWindow.webContents.send('mouse-back-button-clicked');
    }
  });

  windowMap.set(windowId, mainWindow);

  // Handle window closure
  attachTrayLifecycle(mainWindow);
  mainWindow.on('closed', () => {
    windowMap.delete(windowId);
    if (windowMap.size === 0 && !tray) app.quit();

    pendingInitialMessages.delete(windowId);
    pendingDeepLinks.delete(windowId);
    reactReadyWindows.delete(windowId);

  });
  return mainWindow;
};

let activeLauncherWindow: BrowserWindow | null = null;

const createLauncher = () => {
  if (activeLauncherWindow && !activeLauncherWindow.isDestroyed()) {
    activeLauncherWindow.focus();
    return activeLauncherWindow;
  }

  const launcherWindow = new BrowserWindow({
    width: 600,
    height: 80,
    frame: false,
    transparent: process.platform === 'darwin',
    backgroundColor: process.platform === 'darwin' ? '#00000000' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      additionalArguments: [
        JSON.stringify({
          ...appConfig,
          GOOSE_LOCALE: getConfiguredGooseLocale(),
        }),
      ],
      partition: localProfilePartition,
    },
    skipTaskbar: true,
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: true,
    vibrancy: process.platform === 'darwin' ? 'window' : undefined,
  });

  // Center on screen
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  const windowBounds = launcherWindow.getBounds();

  launcherWindow.setPosition(
    Math.round(width / 2 - windowBounds.width / 2),
    Math.round(height / 3 - windowBounds.height / 2)
  );

  // Load launcher window content
  const url = getAppUrl();

  url.hash = '/launcher';
  markAuxiliaryWindow(launcherWindow);
  launcherWindow.loadURL(formatUrl(url));
  activeLauncherWindow = launcherWindow;

  launcherWindow.on('closed', () => {
    reactReadyWindows.delete(launcherWindow.id);
    activeLauncherWindow = null;
  });

  // Destroy window when it loses focus
  launcherWindow.on('blur', () => {
    launcherWindow.destroy();
  });

  // Also destroy on escape key
  launcherWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Escape') {
      launcherWindow.destroy();
      event.preventDefault();
    }
  });

  return launcherWindow;
};

// Track tray instance
let tray: Tray | null = null;
const attachTrayLifecycle = registerTrayLifecycle(
  app,
  () => !!tray && !tray.isDestroyed(),
  process.platform,
  () => harnessQuitFinished,
  () => windowMap.size === 1
);

let refreshTrayMenu: (() => void) | undefined;
const destroyTray = () => {
  refreshTrayMenu = undefined;
  if (tray) {
    tray.destroy();
    tray = null;
  }
};

const disableTray = () => {
  updateSettings((s) => {
    s.showMenuBarIcon = false;
  });
};

const createTray = () => {
  destroyTray();

  const trayIcon = trayIconFileName(process.platform);
  const possiblePaths = [
    path.join(process.resourcesPath, 'images', trayIcon),
    path.join(process.cwd(), 'src', 'images', trayIcon),
    path.join(__dirname, '..', 'images', trayIcon),
    path.join(__dirname, 'images', trayIcon),
    path.join(process.cwd(), 'images', trayIcon),
  ];

  const iconPath = possiblePaths.find((p) => fsSync.existsSync(p));

  if (!iconPath) {
    console.warn('[Main] Tray icon not found. App will continue without system tray.');
    disableTray();
    return;
  }

  try {
    tray = new Tray(iconPath);
    tray.setToolTip(trayTooltip);
    refreshTrayMenu = configureTray(tray, iconPath, {
      translate: nativeT,
      open: showWindow,
      newWindow: () => { void createNewWindow(app); },
      settings: (section) => {
        const win = revealChatOnActivate(applicationWindows());
        if (win && reactReadyWindows.has(win.id) && !win.webContents.isLoadingMainFrame()) {
          win.webContents.send('set-view', 'settings', section);
        } else {
          void createChat(app, { viewType: 'settings', settingsSection: section });
        }
      },
    });

    if (process.platform === 'win32') {
      tray.on('click', showWindow);
    }
  } catch (error) {
    console.error('[Main] Tray creation failed. App will continue without system tray.', error);
    disableTray();
    tray = null;
  }
};

const showWindow = async () => {
  if (!revealChatOnActivate(applicationWindows())) await createChat(app);
};

async function openDirectoryInCurrentWindow(
  dir: string,
  preferredWindow = BrowserWindow.getFocusedWindow()
) {
  const windows = applicationWindows();
  const targetWindow = (preferredWindow && windows.includes(preferredWindow)
    ? preferredWindow
    : windows[0]) ?? await createChat(app);
  if (!targetWindow || targetWindow.isDestroyed()) return;

  if (!(await selectProjectFolder(targetWindow, dir))) return;
  if (targetWindow.isMinimized()) targetWindow.restore();
  targetWindow.show();
  targetWindow.focus();
  return targetWindow;
}

const buildRecentFilesMenu = () => {
  const recentDirs = loadRecentDirs();
  return recentDirs.map((dir) => ({
    label: dir,
    click: async () => {
      const currentWindow = BrowserWindow.getFocusedWindow();
      if (currentWindow) await selectProjectFolder(currentWindow, dir);
    },
  }));
};

async function selectProjectFolder(currentWindow: BrowserWindow, directory: string) {
  try {
    const selected = await openProjectFolderInWindow(
      currentWindow,
      directory,
      async (canonical) => {
        const result = await dialog.showMessageBox(currentWindow, {
          type: 'question',
          title: nativeT('Trust this folder?', '信任此文件夹吗？', '信任此資料夾嗎？'),
          message: canonical,
          detail: nativeT(
            'Use this folder for a new task. When you send a task, CodeBuddy can read files and perform edits or commands according to the selected permissions. Continue only if you trust its contents.',
            '将此文件夹用于新任务。发送任务后，CodeBuddy 可以读取其中的文件，并按你选择的权限修改文件或运行命令。请确认你信任其中的内容。',
            '將此資料夾用於新任務。傳送任務後，CodeBuddy 可以讀取其中的檔案，並依你選擇的權限修改檔案或執行命令。請確認你信任其中的內容。'
          ),
          buttons: [
            nativeT('Trust folder', '信任文件夹', '信任資料夾'),
            nativeT('Cancel', '取消', '取消'),
          ],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        return result.response === 0;
      }
    );
    if (selected) addRecentDir(selected);
    return selected;
  } catch (error) {
    log.warn('Failed to select project folder:', error);
    if (!currentWindow.isDestroyed())
      await dialog.showMessageBox(currentWindow, {
        type: 'error',
        message: nativeT(
          'The folder is unavailable. Select an existing folder.',
          '文件夹不可用，请选择一个现有文件夹。',
          '資料夾不可用，請選擇現有資料夾。'
        ),
      });
    return undefined;
  }
}

const openDirectoryDialog = async (): Promise<OpenDialogReturnValue> => {
  // Get the current working directory from the focused window
  let defaultPath: string | undefined;
  const currentWindow = BrowserWindow.getFocusedWindow();

  if (currentWindow) {
    try {
      const currentWorkingDir = await currentWindow.webContents.executeJavaScript(
        `window.appConfig ? window.appConfig.get('GOOSE_WORKING_DIR') : null`
      );

      if (currentWorkingDir && typeof currentWorkingDir === 'string') {
        // Verify the directory exists before using it as default
        try {
          const stats = fsSync.lstatSync(currentWorkingDir);
          if (stats.isDirectory()) {
            defaultPath = currentWorkingDir;
          }
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error) {
            const fsError = error as { code?: string; message?: string };
            if (
              fsError.code === 'ENOENT' ||
              fsError.code === 'EACCES' ||
              fsError.code === 'EPERM'
            ) {
              console.warn(
                `Current working directory not accessible (${fsError.code}): ${currentWorkingDir}, falling back to home directory`
              );
              defaultPath = os.homedir();
            } else {
              console.warn(
                `Unexpected filesystem error (${fsError.code}) for directory ${currentWorkingDir}:`,
                fsError.message
              );
              defaultPath = os.homedir();
            }
          } else {
            console.warn(`Unexpected error checking directory ${currentWorkingDir}:`, error);
            defaultPath = os.homedir();
          }
        }
      }
    } catch (error) {
      console.warn('Failed to get current working directory from window:', error);
    }
  }

  if (!defaultPath) {
    defaultPath = os.homedir();
  }

  if (!currentWindow) return { canceled: true, filePaths: [] };
  const result = (await dialog.showOpenDialog(currentWindow, {
    properties: ['openDirectory'],
    defaultPath: defaultPath,
  })) as unknown as OpenDialogReturnValue;

  if (!result.canceled && result.filePaths.length > 0) {
    await selectProjectFolder(currentWindow, result.filePaths[0]);
  }
  return result;
};

interface RecipeDeeplinkData {
  config: string;
  parameters?: Record<string, string>;
}

function parseRecipeDeeplink(url: string): RecipeDeeplinkData | undefined {
  const parsedUrl = new URL(url);
  let recipeDeeplink = parsedUrl.searchParams.get('config');
  if (recipeDeeplink && !url.includes(recipeDeeplink)) {
    // URLSearchParams decodes + as space, which can break encoded configs
    // Parse raw query to preserve "+" characters in values like config
    const search = parsedUrl.search || '';
    const configMatch = search.match(/(?:[?&])config=([^&]*)/);
    let recipeDeeplinkTmp = configMatch ? configMatch[1] : null;
    if (recipeDeeplinkTmp) {
      try {
        recipeDeeplink = decodeURIComponent(recipeDeeplinkTmp);
      } catch (error) {
        console.error('[Main] parseRecipeDeeplink - Failed to decode:', errorMessage(error));
        return undefined;
      }
    }
  }
  if (!recipeDeeplink) {
    return undefined;
  }

  // Extract all query parameters except 'config' and 'scheduledJob' as recipe parameters
  // Use raw query string parsing to preserve '+' characters (consistent with config handling)
  const parameters: Record<string, string> = {};
  const search = parsedUrl.search || '';
  const paramMatches = search.matchAll(/[?&]([^=&]+)=([^&]*)/g);

  for (const match of paramMatches) {
    const key = match[1];
    const rawValue = match[2];

    if (key !== 'config' && key !== 'scheduledJob') {
      try {
        parameters[key] = decodeURIComponent(rawValue);
      } catch {
        // If decoding fails, use raw value
        parameters[key] = rawValue;
      }
    }
  }

  return {
    config: recipeDeeplink,
    parameters: Object.keys(parameters).length > 0 ? parameters : undefined,
  };
}

// Global error handler
const handleFatalError = (error: Error) => {
  const windows = applicationWindows();
  windows.forEach((win) => {
    win.webContents.send('fatal-error', error.message || 'An unexpected error occurred');
  });
};

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', formatErrorForLogging(error));
  handleFatalError(error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', formatErrorForLogging(error));
  handleFatalError(error instanceof Error ? error : new Error(String(error)));
});

ipcMain.on('react-ready', (event) => {
  log.info('React ready event received');

  // Get the window that sent the react-ready event
  const window = BrowserWindow.fromWebContents(event.sender);
  const windowId = window?.id;

  if (windowId !== undefined && !reactReadyWindows.has(windowId)) {
    reactReadyWindows.add(windowId);
  }

  if (window && !window.isDestroyed()) {
    window.show();
    window.webContents.invalidate();
  }

  // Send any pending initial message for this window
  if (windowId && pendingInitialMessages.has(windowId)) {
    const { message, ...options } = pendingInitialMessages.get(windowId)!;
    log.info('Sending pending initial message to window:', message);
    window.webContents.send('set-initial-message', message, options);
    pendingInitialMessages.delete(windowId);
  }

  if (windowId && pendingDeepLinks.has(windowId) && window) {
    const deepLinkUrl = pendingDeepLinks.get(windowId)!;
    pendingDeepLinks.delete(windowId);
    log.info('Processing pending deep link for window:', windowId);
    try {
      const parsedUrl = new URL(deepLinkUrl);
      if (parsedUrl.hostname === 'extension') {
        window.webContents.send('add-extension', deepLinkUrl);
      } else if (parsedUrl.hostname === 'sessions') {
        sendOpenSharedSession(window, deepLinkUrl);
      }
    } catch (error) {
      log.error('Error processing pending deep link:', error);
    }
  }
});

ipcMain.handle('open-external', async (_event, url: string) => {
  const parsedUrl = new URL(url);

  if (BLOCKED_PROTOCOLS.includes(parsedUrl.protocol)) {
    console.warn(`[Main] Blocked dangerous protocol: ${parsedUrl.protocol}`);
    return;
  }

  await shell.openExternal(url);
});

ipcMain.handle('directory-chooser', async (_event, multiple = false) => {
  return dialog.showOpenDialog({
    properties: multiple === true ? ['openDirectory', 'multiSelections'] : ['openDirectory', 'createDirectory'],
    defaultPath: os.homedir(),
  });
});

ipcMain.handle('default-codepro-workspace-path', async () => {
  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('-');
  const projectsRoot = process.env.CODEBUDDY_WORKSPACE_ROOT;
  if (!projectsRoot || !path.isAbsolute(projectsRoot)) {
    throw new Error('A valid default workspace root is required');
  }
  await fs.mkdir(projectsRoot, { recursive: true });
  const canonicalRoot = await fs.realpath(projectsRoot);
  // Allocation only proposes a fresh child. The ACP workspace owner creates and
  // validates it before the existing renderer confirmation/session sequence.
  return path.join(canonicalRoot, `${timestamp}-${crypto.randomUUID().slice(0, 8)}`);
});

ipcMain.handle(
  'inspect-codepro-workspace',
  async (_event, input: { prompt?: unknown; selectedWorkingDir?: unknown }) => {
    if (typeof input?.selectedWorkingDir !== 'string' || !input.selectedWorkingDir.trim()) {
      throw new Error('A valid selected working directory is required');
    }
    const prompt = typeof input.prompt === 'string' ? input.prompt.slice(0, 4_000) : '';
    return inspectCodeProWorkspace({
      prompt,
      selectedWorkingDir: input.selectedWorkingDir,
    });
  }
);

ipcMain.handle(
  'confirm-codepro-workspace',
  async (
    _event,
    input: {
      normalizedPath?: unknown;
      expectedState?: unknown;
      expectedIdentity?: unknown;
    }
  ) => {
    if (typeof input?.normalizedPath !== 'string' || !input.normalizedPath.trim()) {
      throw new Error('A valid normalized workspace path is required');
    }
    if (
      input.expectedState !== 'missing' &&
      input.expectedState !== 'empty-directory' &&
      input.expectedState !== 'non-empty-directory'
    ) {
      throw new Error('A valid inspected workspace state is required');
    }
    if (typeof input.expectedIdentity !== 'string' || !input.expectedIdentity.trim()) {
      throw new Error('A valid inspected workspace identity is required');
    }
    return confirmCodeProWorkspace({
      normalizedPath: input.normalizedPath,
      expectedState: input.expectedState,
      expectedIdentity: input.expectedIdentity,
    });
  }
);

let draftStore: DraftStore | undefined;
const draftOwners = new Set<number>();
ipcMain.handle('new-task-draft', (event, request) => {
  const owner = event.sender;
  if (!BrowserWindow.fromWebContents(owner)) throw new Error('Drafts require an application window');
  draftStore ??= new DraftStore(path.join(app.getPath('userData'), 'new-task-drafts-v1'));
  if (!draftOwners.has(owner.id)) {
    draftOwners.add(owner.id);
    const id = owner.id;
    owner.once('destroyed', () => { draftStore?.release(id); draftOwners.delete(id); });
  }
  return draftStore.request(owner.id, request);
});

ipcMain.handle('add-recent-dir', (_event, dir: string) => {
  if (dir) {
    addRecentDir(dir);
  }
});

ipcMain.handle('list-recent-dirs', () => {
  return loadRecentDirs();
});

ipcMain.handle('list-git-worktree-dirs', async (_event, dir: string) => {
  return await listGitWorktreeDirs(dir);
});

ipcMain.handle('get-setting', (_event, key: SettingKey) => {
  const settings = getSettings();
  return settings[key];
});

// Valid setting keys for runtime validation
const validSettingKeys: Set<string> = new Set([
  'showMenuBarIcon',
  'showDockIcon',
  'enableWakelock',
  'enableNotifications',
  'spellcheckEnabled',
  'externalGoosed',
  'globalShortcut',
  'keyboardShortcuts',
  'theme',
  'useSystemTheme',
  'language',
  'responseStyle',
  'showPricing',
  'windowZoom',
  'textSize',
  'codeFontSize',
  'uiFont',
  'seenAnnouncementIds',
  'disableAutoDownload',
]);

function saveTypography(key: keyof Typography, value: unknown) {
  const settings = getSettings();
  const typography = readTypography({ ...settings, [key]: value });
  if (typography[key] !== value) throw new Error('Invalid typography setting');
  fsSync.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...settings, ...typography }, null, 2));
  for (const win of windowMap.values()) {
    if (win.isDestroyed()) continue;
    if (key === 'windowZoom') win.webContents.setZoomFactor(typography.windowZoom / 100);
    win.webContents.send('typography-changed', typography);
  }
}

ipcMain.handle('set-setting', (_event, key: SettingKey, value: unknown) => {
  // Validate key at runtime to prevent prototype pollution
  if (!validSettingKeys.has(key)) {
    console.error(`Invalid setting key rejected: ${key}`);
    return;
  }

  if (key === 'language' && !isValidLanguageSetting(value)) {
    console.error(`Invalid language setting rejected: ${String(value)}`);
    return;
  }

  if (key === 'windowZoom' || key === 'textSize' || key === 'codeFontSize' || key === 'uiFont') return saveTypography(key, value);
  const settings = getSettings();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (settings as any)[key] = value;
  fsSync.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));

  if (key === 'enableWakelock') taskWakelock.setEnabled(value === true);
  if (key === 'language') {
    appConfig.GOOSE_LOCALE = getConfiguredGooseLocale();
    refreshTrayMenu?.();
  }

  // Re-register shortcuts if keyboard shortcuts changed
  if (key === 'keyboardShortcuts') {
    registerGlobalShortcuts();
  }

  if (key === 'disableAutoDownload') {
    setAutoDownloadDisabled(value as boolean);
  }
});

ipcMain.handle('get-secret-key', async (event) => {
  const windowId = BrowserWindow.fromWebContents(event.sender)?.id;
  if (!windowId) {
    return null;
  }
  await pendingWindowBindings.get(windowId);
  return gooseServeLeases.getSecretKey(windowId) ?? null;
});

ipcMain.handle('startup-model-configured', async event => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || !pendingWindowBindings.has(owner.id)) return true;
  return (await packagedStartup()).modelConfigured;
});

ipcMain.handle('get-acp-url', async (event) => {
  const windowId = BrowserWindow.fromWebContents(event.sender)?.id;
  if (!windowId) {
    return null;
  }
  await pendingWindowBindings.get(windowId);
  return gooseServeLeases.getAcpUrl(windowId) ?? null;
});

// Handle menu bar icon visibility
ipcMain.handle('set-menu-bar-icon', async (_event, show: boolean) => {
  updateSettings((s) => {
    s.showMenuBarIcon = show;
  });

  if (show) {
    createTray();
  } else {
    destroyTray();
  }
  return true;
});

ipcMain.handle('get-menu-bar-icon-state', () => {
  try {
    const settings = getSettings();
    return settings.showMenuBarIcon ?? true;
  } catch (error) {
    console.error('Error getting menu bar icon state:', error);
    return true;
  }
});

// Handle dock icon visibility (macOS only)
ipcMain.handle('set-dock-icon', async (_event, show: boolean) => {
  if (process.platform !== 'darwin') return false;

  const settings = getSettings();
  updateSettings((s) => {
    s.showDockIcon = show;
  });

  if (show) {
    app.dock?.show();
  } else {
    // Only hide the dock if we have a menu bar icon to maintain accessibility
    if (settings.showMenuBarIcon) {
      app.dock?.hide();
      setTimeout(() => {
        focusWindow();
      }, 50);
    }
  }
  return true;
});

ipcMain.handle('get-dock-icon-state', () => {
  try {
    if (process.platform !== 'darwin') return true;
    const settings = getSettings();
    return settings.showDockIcon ?? true;
  } catch (error) {
    console.error('Error getting dock icon state:', error);
    return true;
  }
});

// Handle opening system notifications preferences
ipcMain.handle('open-notifications-settings', async () => {
  try {
    if (process.platform === 'darwin') {
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.notifications');
      return true;
    } else if (process.platform === 'win32') {
      // Windows: Open notification settings in Settings app
      await shell.openExternal('ms-settings:notifications');
      return true;
    } else if (process.platform === 'linux') {
      // Linux: Try different desktop environments
      function canSpawn(cmd: string): boolean {
        try {
          execFileSync('which', [cmd], { stdio: 'ignore' });
          return true;
        } catch {
          return false;
        }
      }

      const managers = [
        ['gnome-control-center', 'notifications'],
        ['systemsettings', 'kcm_notifications'],
        ['systemsettings5', 'kcm_notifications'],
        ['xfce4-notifyd-config'],
      ];
      for (const [command, ...args] of managers) {
        if (canSpawn(command)) {
          await new Promise<void>((resolve, reject) => {
            const child = spawn(command, args, { stdio: 'ignore' });
            child.once('error', reject);
            child.once('spawn', resolve);
          });
          return true;
        }
      }

      console.warn('Could not find a suitable settings application for Linux');
      return false;
    } else {
      console.warn(
        `Opening notification settings is not supported on platform: ${process.platform}`
      );
      return false;
    }
  } catch (error) {
    console.error('Error opening notification settings:', error);
    return false;
  }
});

// Handle wakelock setting
ipcMain.handle('set-wakelock', async (_event, enable: boolean) => {
  updateSettings((s) => {
    s.enableWakelock = enable;
  });

  taskWakelock.setEnabled(enable);
  return true;
});

ipcMain.handle('get-wakelock-state', () => {
  try {
    const settings = getSettings();
    return settings.enableWakelock ?? false;
  } catch (error) {
    console.error('Error getting wakelock state:', error);
    return false;
  }
});

ipcMain.handle('set-spellcheck', async (_event, enable: boolean) => {
  updateSettings((s) => {
    s.spellcheckEnabled = enable;
  });
  return true;
});

ipcMain.handle('get-spellcheck-state', () => {
  try {
    const settings = getSettings();
    return settings.spellcheckEnabled ?? true;
  } catch (error) {
    console.error('Error getting spellcheck state:', error);
    return true;
  }
});

ipcMain.handle('is-any-window-focused', () => {
  return BrowserWindow.getFocusedWindow() !== null;
});

ipcMain.handle('get-is-fullscreen', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win?.isFullScreen() ?? false;
});

registerWindowMenu((window) => applicationWindows().includes(window));

// Add file/directory selection handler
ipcMain.handle('select-file-or-directory', async (_event, defaultPath?: string) => {
  const dialogOptions: OpenDialogOptions = {
    properties: process.platform === 'darwin' ? ['openFile', 'openDirectory'] : ['openFile'],
  };

  // Set default path if provided
  if (defaultPath) {
    // Expand tilde to home directory
    const expandedPath = expandTilde(defaultPath);

    // Check if the path exists
    try {
      const stats = await fs.stat(expandedPath);
      if (stats.isDirectory()) {
        dialogOptions.defaultPath = expandedPath;
      } else {
        dialogOptions.defaultPath = path.dirname(expandedPath);
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      // If path doesn't exist, fall back to home directory and log error
      console.error(`Default path does not exist: ${expandedPath}, falling back to home directory`);
      dialogOptions.defaultPath = os.homedir();
    }
  }

  const result = (await dialog.showOpenDialog(dialogOptions)) as unknown as OpenDialogReturnValue;

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('select-root-cleanup-target', async (_event, rootPath: string) => {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) {
    throw new Error('Root cleanup picker requires an absolute root path');
  }
  const stats = await fs.lstat(rootPath);
  const result = (await dialog.showOpenDialog(
    rootCleanupDialogOptions(rootPath, stats)
  )) as unknown as OpenDialogReturnValue;
  if (result.canceled || result.filePaths.length !== 1) {
    return null;
  }
  return result.filePaths[0];
});

// Native picker tailored for session imports: shows hidden files (so users can
// reach `~/.claude/projects/...` or `~/.pi/agent/sessions/...`), filters for
// .json/.jsonl, and returns the file's contents inline so the renderer doesn't
// need a separate read step.
ipcMain.handle('select-import-session-file', async () => {
  const result = (await dialog.showOpenDialog({
    title: nativeT('Import session', '导入会话', '匯入工作階段'),
    defaultPath: os.homedir(),
    properties: ['openFile', 'showHiddenFiles'],
    filters: [
      {
        name: nativeT('Session files', '会话文件', '工作階段檔案'),
        extensions: ['json', 'jsonl'],
      },
      { name: nativeT('All files', '所有文件', '所有檔案'), extensions: ['*'] },
    ],
  })) as unknown as OpenDialogReturnValue;

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  const filePath = result.filePaths[0];
  try {
    const contents = await fs.readFile(filePath, 'utf8');
    return { filePath, contents };
  } catch (err) {
    return { filePath, contents: '', error: errorMessage(err) };
  }
});

ipcMain.handle('check-ollama', async () => {
  try {
    return new Promise((resolve) => {
      // Run `ps` and filter for "ollama"
      const ps = spawn('ps', ['aux']);
      const grep = spawn('grep', ['-iw', '[o]llama']);

      let output = '';
      let errorOutput = '';

      // Pipe ps output to grep
      ps.stdout.pipe(grep.stdin);

      grep.stdout.on('data', (data) => {
        output += data.toString();
      });

      grep.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      grep.on('close', (code) => {
        if (code !== null && code !== 0 && code !== 1) {
          // grep returns 1 when no matches found
          console.error('Error executing grep command:', errorOutput);
          return resolve(false);
        }

        const trimmedOutput = output.trim();

        const isRunning = trimmedOutput.length > 0;
        resolve(isRunning);
      });

      ps.on('error', (error) => {
        console.error('Error executing ps command:', error);
        resolve(false);
      });

      grep.on('error', (error) => {
        console.error('Error executing grep command:', error);
        resolve(false);
      });

      // Close ps stdin when done
      ps.stdout.on('end', () => {
        grep.stdin.end();
      });
    });
  } catch (err) {
    console.error('Error checking for Ollama:', err);
    return false;
  }
});

ipcMain.handle('read-file', async (_event, filePath) => readFileResponse(expandTilde(filePath)));

registerPastedTextOpen();
registerWorkspacePanel({
  get: () => getSettings().defaultCodeEditor,
  set: (editor) =>
    updateSettings((settings) => {
      settings.defaultCodeEditor = editor;
    }),
  t: nativeT,
});
registerGitHubCliAuth();

ipcMain.handle('read-workspace-file', async (_event, workspaceRoot, requestedPath) => {
  try {
    if (typeof workspaceRoot !== 'string' || typeof requestedPath !== 'string') {
      throw new Error('文件路径无效');
    }
    const filePath = resolveWorkspaceFilePath(workspaceRoot, requestedPath);
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) throw new Error('所选路径不是文件');
    if (stats.size > 512 * 1024) throw new Error('文件超过 512 KB，无法在侧栏预览');

    return {
      file: await fs.readFile(filePath, 'utf8'),
      filePath,
      error: null,
      found: true,
    };
  } catch (error) {
    return {
      file: '',
      filePath: requestedPath,
      error: error instanceof Error ? error.message : String(error),
      found: false,
    };
  }
});

ipcMain.handle('write-file', async (_event, filePath, content) => {
  try {
    // Expand tilde to home directory
    const expandedPath = expandTilde(filePath);
    await fs.writeFile(expandedPath, content, { encoding: 'utf8' });
    return true;
  } catch (error) {
    console.error('Error writing to file:', error);
    return false;
  }
});

// Enhanced file operations
ipcMain.handle('ensure-directory', async (_event, dirPath) => {
  try {
    // Expand tilde to home directory
    const expandedPath = expandTilde(dirPath);

    await fs.mkdir(expandedPath, { recursive: true });
    return true;
  } catch (error) {
    console.error('Error creating directory:', error);
    return false;
  }
});

ipcMain.handle('list-files', async (_event, dirPath, extension) => {
  try {
    // Expand tilde to home directory
    const expandedPath = expandTilde(dirPath);

    const files = await fs.readdir(expandedPath);
    if (extension) {
      return files.filter((file) => file.endsWith(extension));
    }
    return files;
  } catch (error) {
    console.error('Error listing files:', error);
    return [];
  }
});

ipcMain.handle('show-message-box', async (_event, options) => {
  return dialog.showMessageBox(options);
});

ipcMain.handle('show-save-dialog', async (_event, options) => {
  const { defaultDirectory, ...dialogOptions } = options;
  if (defaultDirectory === 'desktop') {
    dialogOptions.defaultPath = path.join(app.getPath('desktop'), path.basename(dialogOptions.defaultPath || ''));
  }
  return dialog.showSaveDialog(dialogOptions);
});

ipcMain.handle('get-allowed-extensions', async () => {
  return await getAllowList();
});

const createNewWindow = async (app: App, dir?: string | null) => {
  return await createChat(app, { dir: dir?.trim() || undefined });
};

const focusWindow = () => {
  const windows = applicationWindows();
  if (windows.length > 0) {
    windows.forEach((win) => {
      win.show();
    });
    windows[windows.length - 1].webContents.send('focus-input');
  } else {
    createNewWindow(app);
  }
};

const registerGlobalShortcuts = () => {
  globalShortcut.unregisterAll();

  const settings = getSettings();
  const shortcuts = getKeyboardShortcuts(settings);

  if (shortcuts.focusWindow) {
    try {
      globalShortcut.register(shortcuts.focusWindow, () => {
        focusWindow();
      });
    } catch (e) {
      console.error('Error registering focus window hotkey:', e);
    }
  }

  if (shortcuts.quickLauncher) {
    try {
      globalShortcut.register(shortcuts.quickLauncher, () => {
        createLauncher();
      });
    } catch (e) {
      console.error('Error registering launcher hotkey:', e);
    }
  }
};

// All launch paths (including file and URL opens) share one child and one readiness result.
let startupPromise: ReturnType<typeof bootPackagedHarness> | undefined;
function packagedStartup() {
  if (!startupPromise) {
    startupPromise = bootPackagedHarness();
    // appMain observes the failure after registering the desktop event handlers.
    void startupPromise.catch(() => {});
  }
  return startupPromise;
}
async function bootPackagedHarness() {
  packagedHarnessService = await startHarnessService({
    resourcesPath: process.resourcesPath,
    userData: app.getPath('userData'),
    home: storagePaths.homeDir,
    workspace: process.env.CODEBUDDY_WORKSPACE_ROOT!,
    onUnexpectedExit: () => {
      log.error('Packaged Harness exited unexpectedly; preserving conversation data');
      app.quit();
    },
  });
  process.env.CODEBUDDY_EXTERNAL_BACKEND = 'true';
  process.env.CODEBUDDY_EXTERNAL_BACKEND_URL = packagedHarnessService.url;
  process.env.CODEBUDDY_SERVER__SECRET_KEY = packagedHarnessService.secret;
  const response = await net.fetch(`${packagedHarnessService.url}/status`, {
    headers: { 'X-Secret-Key': packagedHarnessService.secret }, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`CodeBuddy startup status: HTTP ${response.status}`);
  const status = await response.json();
  return { service: packagedHarnessService, modelConfigured: status.modelConfigured === true };
}

async function appMain() {
  const startup = harnessPackaged ? packagedStartup() : undefined;
  powerMonitor.on('resume', () => {
    for (const window of applicationWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('system-resume');
      }
    }
  });

  await configureProxy();

  registerProductUpdates({
    requestNetworkAccess,
    hasTerminals: hasWorkspaceTerminals,
    reserveTerminals: reserveWorkspaceUpdate,
    closeForUpdate: async () => {
      if (!packagedHarnessService) throw new Error('请使用安装版执行升级。');
      await packagedHarnessService.closeForUpdate();
      harnessQuitFinished = true;
    },
  });

  // Handle microphone permission requests
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    console.log('Permission requested:', permission);
    // Allow microphone and media access
    if (permission === 'media') {
      callback(true);
    } else {
      // Default behavior for other permissions
      callback(true);
    }
  });

  // Add CSP headers to all sessions, recomputed on every response so external
  // backend settings take effect without restarting the app.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const currentSettings = getSettings();
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': buildCSP(getExternalBackendForCsp(currentSettings)),
      },
    });
  });

  // Migrate old settings format if needed (one-time migration)
  const settings = getSettings();
  if (!settings.keyboardShortcuts && settings.globalShortcut !== undefined) {
    updateSettings((s) => {
      s.keyboardShortcuts = getKeyboardShortcuts(s);
      delete s.globalShortcut;
    });
  }

  // Register global shortcuts based on settings
  registerGlobalShortcuts();

  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['Origin'] = 'http://localhost:5173';
    callback({ cancel: false, requestHeaders: details.requestHeaders });
  });

  if (settings.showMenuBarIcon) {
    createTray();
  }

  if (process.platform === 'darwin' && !settings.showDockIcon && settings.showMenuBarIcon) {
    app.dock?.hide();
  }

  const { dirPath } = parseArgs();

  const fileOpenedAtLaunch = await fileOpenQueue.start();
  if (!openUrlHandledLaunch && !fileOpenedAtLaunch) {
    await createNewWindow(app, dirPath);
  } else {
    log.info(
      '[Main] Skipping window creation in appMain - an external open request already handled launch'
    );
  }

  if (process.platform === 'darwin') {
    const dockMenu = Menu.buildFromTemplate([
      {
        label: menuT('New Window'),
        click: () => {
          createNewWindow(app);
        },
      },
    ]);
    app.dock?.setMenu(dockMenu);
  }

  let menu = Menu.getApplicationMenu();

  const shortcuts = getKeyboardShortcuts(settings);

  const appMenu = menu?.items.find((item) => item.label === distro.productName);
  if (appMenu?.submenu) {
    if (process.platform === 'darwin' && app.isPackaged) {
      appMenu.submenu.append(new MenuItem({ type: 'separator' }));
      appMenu.submenu.append(new MenuItem({
        label: nativeT('Uninstall CodeBuddy…', '卸载 CodeBuddy…', '解除安裝 CodeBuddy…'),
        click: () => { void showMacUninstall({ dataRoot: storagePaths.homeDir,
          workspace: process.env.CODEBUDDY_WORKSPACE_ROOT || storagePaths.workspacesDir,
          runtimePid: packagedHarnessService?.pid, t: nativeT }); },
      }));
    }
    appMenu.submenu.insert(1, new MenuItem({ type: 'separator' }));
    if (shortcuts.settings) {
      appMenu.submenu.insert(
        1,
        new MenuItem({
          label: menuT('Settings'),
          accelerator: shortcuts.settings,
          click() {
            const focusedWindow = BrowserWindow.getFocusedWindow();
            if (focusedWindow) focusedWindow.webContents.send('set-view', 'settings');
          },
        })
      );
    }
    appMenu.submenu.insert(1, new MenuItem({ type: 'separator' }));
  }

  const editMenu = menu?.items.find((item) => item.label === 'Edit');
  if (editMenu?.submenu) {
    const selectAllIndex = editMenu.submenu.items.findIndex((item) => item.label === 'Select All');

    const findSubmenu = Menu.buildFromTemplate([
      {
        label: menuT('Find…'),
        accelerator: shortcuts.find || undefined,
        click() {
          const focusedWindow = BrowserWindow.getFocusedWindow();
          if (focusedWindow) focusedWindow.webContents.send('find-command');
        },
      },
      {
        label: menuT('Find Next'),
        accelerator: shortcuts.findNext || undefined,
        click() {
          const focusedWindow = BrowserWindow.getFocusedWindow();
          if (focusedWindow) focusedWindow.webContents.send('find-next');
        },
      },
      {
        label: menuT('Find Previous'),
        accelerator: shortcuts.findPrevious || undefined,
        click() {
          const focusedWindow = BrowserWindow.getFocusedWindow();
          if (focusedWindow) focusedWindow.webContents.send('find-previous');
        },
      },
      {
        label: menuT('Use Selection for Find'),
        accelerator: process.platform === 'darwin' ? 'Command+E' : undefined,
        click() {
          const focusedWindow = BrowserWindow.getFocusedWindow();
          if (focusedWindow) focusedWindow.webContents.send('use-selection-find');
        },
        visible: process.platform === 'darwin', // Only show on Mac
      },
    ]);

    editMenu.submenu.insert(
      selectAllIndex + 1,
      new MenuItem({
        label: menuT('Find'),
        submenu: findSubmenu,
      })
    );
  }

  const fileMenu = menu?.items.find((item) => item.label === 'File');

  if (fileMenu?.submenu) {
    // Use a counter to track the actual insertion index
    let menuIndex = 0;

    if (shortcuts.newChat) {
      fileMenu.submenu.insert(
        menuIndex++,
        new MenuItem({
          label: menuT('New Chat'),
          accelerator: shortcuts.newChat,
          click() {
            const focusedWindow = BrowserWindow.getFocusedWindow();
            if (focusedWindow) focusedWindow.webContents.send('set-view', '');
          },
        })
      );
    }

    if (shortcuts.newChatWindow) {
      fileMenu.submenu.insert(
        menuIndex++,
        new MenuItem({
          label: menuT('New Chat Window'),
          accelerator: shortcuts.newChatWindow,
          click() {
            ipcMain.emit('create-chat-window');
          },
        })
      );
    }

    if (shortcuts.openDirectory) {
      fileMenu.submenu.insert(
        menuIndex++,
        new MenuItem({
          label: menuT('Open Directory...'),
          accelerator: shortcuts.openDirectory,
          click: () => openDirectoryDialog(),
        })
      );
    }

    fileMenu.submenu.insert(
      menuIndex++,
      new MenuItem({
        label: nativeT(
          'Open CodeBuddy Data Folder',
          '打开 CodeBuddy 数据目录',
          '開啟 CodeBuddy 資料目錄'
        ),
        click: async () => {
          const error = await shell.openPath(storagePaths.homeDir);
          if (error) log.error('Could not open CodeBuddy data directory', error);
        },
      })
    );

    const recentFilesSubmenu = buildRecentFilesMenu();
    {
      const recentItem = new MenuItem({
        label: menuT('Recent Directories'),
        submenu: recentFilesSubmenu,
        enabled: recentFilesSubmenu.length > 0,
      });
      fileMenu.submenu.insert(
        menuIndex++,
        recentItem
      );
      onRecentDirsChanged(() => {
        const items = buildRecentFilesMenu();
        // Electron binds submenu references at construction time. Rebuild only
        // this branch, preserving the other menu items and their click handlers.
        const updatedRecent = new MenuItem({
          label: recentItem.label,
          submenu: items,
          enabled: items.length > 0,
        });
        const updatedFile = new MenuItem({
          label: fileMenu.label,
          submenu: Menu.buildFromTemplate(
            fileMenu.submenu!.items.map((item) => item === recentItem ? updatedRecent : item)
          ),
        });
        Menu.setApplicationMenu(Menu.buildFromTemplate(
          menu!.items.map((item) => item === fileMenu ? updatedFile : item)
        ));
      });
    }

    fileMenu.submenu.insert(menuIndex++, new MenuItem({ type: 'separator' }));

    if (shortcuts.focusWindow) {
      fileMenu.submenu.append(
        new MenuItem({
          label: menuT(`Focus ${distro.productName} Window`),
          accelerator: shortcuts.focusWindow,
          click() {
            focusWindow();
          },
        })
      );
    }

    if (shortcuts.quickLauncher) {
      fileMenu.submenu.append(
        new MenuItem({
          label: menuT('Quick Launcher'),
          accelerator: shortcuts.quickLauncher,
          click() {
            createLauncher();
          },
        })
      );
    }
  }

  if (menu) {
    let windowMenu = menu.items.find((item) => item.label === 'Window');

    if (!windowMenu) {
      windowMenu = new MenuItem({
        label: menuT('Window'),
        submenu: Menu.buildFromTemplate([]),
      });

      const helpMenuIndex = menu.items.findIndex((item) => item.label === 'Help');
      if (helpMenuIndex >= 0) {
        menu.items.splice(helpMenuIndex, 0, windowMenu);
      } else {
        menu.items.push(windowMenu);
      }
    }

    if (windowMenu.submenu) {
      if (shortcuts.alwaysOnTop) {
        windowMenu.submenu.append(
          new MenuItem({
            label: menuT('Always on Top'),
            type: 'checkbox',
            accelerator: shortcuts.alwaysOnTop,
            click(menuItem) {
              const focusedWindow = BrowserWindow.getFocusedWindow();
              if (focusedWindow) {
                const isAlwaysOnTop = menuItem.checked;

                if (process.platform === 'darwin') {
                  focusedWindow.setAlwaysOnTop(isAlwaysOnTop, 'floating');
                } else {
                  focusedWindow.setAlwaysOnTop(isAlwaysOnTop);
                }

                console.log(
                  `[Main] Set always-on-top to ${isAlwaysOnTop} for window ${focusedWindow.id}`
                );
              }
            },
          })
        );
      }
    }

    const viewMenu = menu.items.find((item) => item.label === 'View');
    if (viewMenu?.submenu && shortcuts.toggleNavigation) {
      viewMenu.submenu.append(new MenuItem({ type: 'separator' }));
      viewMenu.submenu.append(
        new MenuItem({
          label: menuT('Toggle Navigation'),
          accelerator: shortcuts.toggleNavigation,
          click() {
            const focusedWindow = BrowserWindow.getFocusedWindow();
            if (focusedWindow) {
              focusedWindow.webContents.send('toggle-navigation');
            }
          },
        })
      );
    }
  }

  // on macOS, the topbar is hidden
  if (menu && process.platform !== 'darwin') {
    let helpMenu = menu.items.find((item) => item.label === 'Help');

    // If Help menu doesn't exist, create it and add it to the menu
    if (!helpMenu) {
      helpMenu = new MenuItem({
        label: menuT('Help'),
        submenu: Menu.buildFromTemplate([]), // Start with an empty submenu
      });
      // Find a reasonable place to insert the Help menu, usually near the end
      const insertIndex = menu.items.length > 0 ? menu.items.length - 1 : 0;
      menu.items.splice(insertIndex, 0, helpMenu);
    }

    // Ensure the Help menu has a submenu before appending
    if (helpMenu.submenu) {
      helpMenu.submenu.append(
        new MenuItem({
          label: menuT('CodeBuddy Documentation'),
          click() {
            void shell.openExternal('https://github.com/erjinyi-bool/CodeBuddy#readme');
          },
        })
      );
      helpMenu.submenu.append(
        new MenuItem({
          label: menuT('Report a CodeBuddy Issue'),
          click() {
            void shell.openExternal('https://github.com/erjinyi-bool/CodeBuddy/issues');
          },
        })
      );

      // Add a separator before the About item if the submenu is not empty
      if (helpMenu.submenu.items.length > 0) {
        helpMenu.submenu.append(new MenuItem({ type: 'separator' }));
      }

      // Create the About Goose menu item with a submenu
      const aboutGooseMenuItem = new MenuItem({
        label: menuT(`About ${distro.productName}`),
        submenu: Menu.buildFromTemplate([]), // Start with an empty submenu for About
      });

      // Add the Version menu item (display only) to the About Goose submenu
      if (aboutGooseMenuItem.submenu) {
        aboutGooseMenuItem.submenu.append(
          new MenuItem({
            label: `Version ${version || app.getVersion()}`,
            enabled: false,
          })
        );
      }

      helpMenu.submenu.append(aboutGooseMenuItem);
    }
  }

  if (menu) {
    // Translate labels (including Electron's default top-level entries
    // File/Edit/View/Window/Help and submenu items populated by roles) before
    // installing the menu. Called last so the lookups above that match on the
    // English labels still succeed.
    const view = menu.items.find(item => item.label === 'View');
    if (view?.submenu) {
      const items = view.submenu.items.map(item => {
        const role = item.role?.toLowerCase();
        if (role !== 'zoomin' && role !== 'zoomout' && role !== 'resetzoom') return item;
        return new MenuItem({
          label: item.label,
          accelerator: item.accelerator ?? ({
            zoomin: 'CommandOrControl+Plus', zoomout: 'CommandOrControl+-', resetzoom: 'CommandOrControl+0',
          }[role]),
          click: () => {
            const current = getSettings().windowZoom;
            const next = role === 'resetzoom' ? defaultTypography.windowZoom :
              current + (role === 'zoomin' ? zoomRange.step : -zoomRange.step);
            saveTypography('windowZoom', Math.min(zoomRange.max, Math.max(zoomRange.min, next)));
          },
        });
      });
      const updatedView = new MenuItem({ label: view.label, submenu: Menu.buildFromTemplate(items) });
      menu = Menu.buildFromTemplate(menu.items.map(item => item === view ? updatedView : item));
    }
    translateMenuLabels(menu.items);
    Menu.setApplicationMenu(menu);
    if (process.platform === 'win32') {
      for (const window of applicationWindows()) window.setMenuBarVisibility(false);
    }
  }

  app.on('activate', () => {
    if (fileOpenQueue.hasPending) return;
    const windows = applicationWindows();
    if (!windows.length) {
      void createNewWindow(app);
    } else if (process.platform === 'darwin') {
      revealChatOnActivate(windows);
    }
  });

  ipcMain.on('create-chat-window', (event, options = {}) => {
    const { query, dir, resumeSessionId, viewType, recipeId, workspaceMode, workspaceBinding } =
      options;

    const resolvedDir = typeof dir === 'string' ? dir.trim() || undefined : undefined;

    const isFromLauncher = query && !resumeSessionId && !viewType && !recipeId;

    if (isFromLauncher) {
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      const launcherWindowId = senderWindow?.id;
      const allWindows = applicationWindows();

      const existingWindows = allWindows.filter(
        (win) => !win.isDestroyed() && win.id !== launcherWindowId
      );

      if (existingWindows.length > 0) {
        const targetWindow = existingWindows[0];
        targetWindow.show();
        targetWindow.focus();
        targetWindow.webContents.send('set-initial-message', query);
        return;
      }
    }

    createChat(app, {
      initialMessage: query,
      dir: resolvedDir,
      resumeSessionId,
      viewType,
      recipeId,
      workspaceMode,
      workspaceBinding,
    });
  });

  ipcMain.on('close-window', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window && !window.isDestroyed()) {
      window.close();
    }
  });

  ipcMain.on('notify', (event, data) => {
    try {
      // Validate notification data
      if (!data || typeof data !== 'object') {
        console.error('Invalid notification data');
        return;
      }

      // Validate title and body
      if (typeof data.title !== 'string' || typeof data.body !== 'string') {
        console.error('Invalid notification title or body');
        return;
      }

      // Limit the length of title and body
      const MAX_LENGTH = 1000;
      if (data.title.length > MAX_LENGTH || data.body.length > MAX_LENGTH) {
        console.error('Notification title or body too long');
        return;
      }

      const owner = BrowserWindow.fromWebContents(event.sender);
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
      const focused = BrowserWindow.getFocusedWindow();
      const notice = { sessionId, title: data.title, body: data.body, messageId: crypto.randomUUID() };
      if (sessionId && owner && process.platform === 'win32' && applicationWindows().includes(owner)) {
        void showCompletionPopup(owner, { ...notice, sessionId }, data.locale || detectMenuLocale(), getAppUrl())
          .catch(error => {
            log.warn('Completion popup unavailable', error);
            if (!owner.isDestroyed()) owner.webContents.send('task-completion-notice', notice);
          });
        return;
      }
      if (sessionId && focused && applicationWindows().includes(focused)) {
        focused.webContents.send('task-completion-notice', notice);
        return;
      }
      const notification = new Notification({ title: data.title, body: data.body });
      notification.on('click', () => {
        if (!owner || owner.isDestroyed()) return;
        if (owner.isMinimized()) owner.restore();
        owner.show();
        owner.focus();
        if (sessionId) owner.webContents.send('pet-open-session', sessionId);
      });
      notification.on('failed', (_event, reason) => log.warn('Completion notification failed', reason));

      notification.show();
    } catch (error) {
      console.error('Error showing notification:', error);
    }
  });

  ipcMain.on('logInfo', (_event, info) => {
    try {
      // Validate log info
      if (info === undefined || info === null) {
        console.error('Invalid log info: undefined or null');
        return;
      }

      // Convert to string if not already
      const logMessage = String(info);

      // Limit log message length
      const MAX_LENGTH = 10000; // 10KB limit
      if (logMessage.length > MAX_LENGTH) {
        console.error('Log message too long');
        return;
      }

      // Log the sanitized message
      log.info('from renderer:', logMessage);
    } catch (error) {
      console.error('Error logging info:', error);
    }
  });

  ipcMain.on('broadcast-theme-change', (event, themeData) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    const allWindows = applicationWindows();

    allWindows.forEach((window) => {
      if (window.id !== senderWindow?.id) {
        window.webContents.send('theme-changed', themeData);
      }
    });
  });

  ipcMain.on('reload-app', (event) => {
    // Get the window that sent the event
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) {
      window.reload();
    }
  });

  ipcMain.on('open-in-chrome', (_event, url) => {
    try {
      // Validate URL
      const parsedUrl = new URL(url);

      // Only allow http and https protocols for browser URLs
      if (!WEB_PROTOCOLS.includes(parsedUrl.protocol)) {
        console.error('Invalid URL protocol. Only HTTP and HTTPS are allowed.');
        return;
      }

      // On macOS, use the 'open' command with Chrome
      if (process.platform === 'darwin') {
        spawn('open', ['-a', 'Google Chrome', url]);
      } else if (process.platform === 'win32') {
        // On Windows, start is built-in command of cmd.exe
        spawn('cmd.exe', ['/c', 'start', '', 'chrome', url]);
      } else {
        // On Linux, use xdg-open with chrome
        spawn('xdg-open', [url]);
      }
    } catch (error) {
      console.error('Error opening URL in browser:', error);
    }
  });

  // Handle app restart
  ipcMain.on('restart-app', () => {
    restartAfterQuit = true;
    app.quit();
  });

  // Handler for getting app version
  ipcMain.on('get-app-version', (event) => {
    event.returnValue = app.getVersion();
  });

  ipcMain.on('get-app-locale', (event) => {
    event.returnValue = getConfiguredGooseLocale();
  });

  ipcMain.handle('open-directory-in-explorer', async (_event, path: string) => {
    try {
      return (await shell.openPath(path)) === '';
    } catch (error) {
      console.error('Error opening directory in explorer:', error);
      return false;
    }
  });

  ipcMain.handle('launch-app', async (event, gooseApp: GooseApp) => {
    try {
      if (isRetiredGooseChatApp(gooseApp)) {
        throw new Error('This built-in Chat app is no longer supported.');
      }

      const launchingWindow = BrowserWindow.fromWebContents(event.sender);
      if (!launchingWindow) {
        throw new Error('Could not find launching window');
      }

      const launchingWindowId = launchingWindow.id;
      await pendingWindowBindings.get(launchingWindowId);
      const launchingGooseServeLease = gooseServeLeases.get(launchingWindowId);
      if (!launchingGooseServeLease) {
        throw new Error('No backend lease found for launching window');
      }

      const workingDir = app.getPath('home');
      const appWindow = new BrowserWindow({
        title: formatAppName(gooseApp.name),
        width: gooseApp.width ?? 800,
        height: gooseApp.height ?? 600,
        resizable: gooseApp.resizable ?? true,
        useContentSize: true,
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          nodeIntegration: false,
          contextIsolation: true,
          webSecurity: true,
          additionalArguments: [
            JSON.stringify({
              ...appConfig,
              GOOSE_LOCALE: getConfiguredGooseLocale(),
              GOOSE_WORKING_DIR: workingDir,
              GOOSE_VERSION: version,
            }),
          ],
          partition: localProfilePartition,
        },
      });

      gooseServeLeases.attachWindow(appWindow.id, launchingGooseServeLease);

      appWindows.set(gooseApp.name, appWindow);

      appWindow.on('closed', () => {
        void gooseServeLeases.releaseWindow(appWindow.id);
        appWindows.delete(gooseApp.name);
      });

      const extensionName = gooseApp.mcpServers?.[0] ?? '';

      const url = getAppUrl();

      const searchParams = new URLSearchParams();
      searchParams.set('resourceUri', gooseApp.uri);
      searchParams.set('extensionName', extensionName);
      searchParams.set('appName', gooseApp.name);
      searchParams.set('workingDir', workingDir);

      url.hash = `/standalone-app?${searchParams.toString()}`;
      await appWindow.loadURL(formatUrl(url));
      appWindow.show();
    } catch (error) {
      console.error('Failed to launch app:', error);
      throw error;
    }
  });

  ipcMain.handle('refresh-app', async (_event, gooseApp: GooseApp) => {
    try {
      const appWindow = appWindows.get(gooseApp.name);
      if (!appWindow || appWindow.isDestroyed()) {
        console.log(`App window for '${gooseApp.name}' not found or destroyed, skipping refresh`);
        return;
      }

      // Bring to front first
      if (appWindow.isMinimized()) {
        appWindow.restore();
      }
      appWindow.show();
      appWindow.focus();

      // Then reload
      await appWindow.webContents.reload();
    } catch (error) {
      console.error('Failed to refresh app:', error);
      throw error;
    }
  });

  ipcMain.handle('close-app', async (_event, appName: string) => {
    try {
      const appWindow = appWindows.get(appName);
      if (!appWindow || appWindow.isDestroyed()) {
        console.log(`App window for '${appName}' not found or destroyed, skipping close`);
        return;
      }

      appWindow.close();
    } catch (error) {
      console.error('Failed to close app:', error);
      throw error;
    }
  });
  await startup;
}

app.whenReady().then(async () => {
  try {
    if (process.platform === 'win32' && !app.isPackaged && !started) {
      try {
        const register = () => registerPreviewShortcut(shell, app.getPath('appData'), process.cwd(), process.execPath);
        register();
        // Initializing Electron's Windows presenter asynchronously creates an extra Electron.lnk.
        // Reconcile the newly generated preview-owned shortcut before the first user notification.
        if (Notification.isSupported()) {
          for (let attempt = 0; attempt < 20; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 100));
            if (register()) break;
          }
        }
      } catch (error) {
        log.warn('Could not register the CodeBuddy preview notification identity', error);
      }
    }
    const maintainCaches = async () => {
      for (const target of [session.defaultSession, session.fromPartition(localProfilePartition)]) {
        try {
          await maintainElectronCache(target);
        } catch (error) {
          log.warn('Browser cache maintenance failed', error);
        }
      }
    };
    await appMain();
    // Large legacy caches must not delay opening the user's main window.
    void maintainCaches();
    const cacheTimer = setInterval(
      () => {
        void maintainCaches();
      },
      6 * 60 * 60 * 1000
    );
    cacheTimer.unref();
    taskWakelock.setEnabled(getSettings().enableWakelock ?? false);
    await registerDesktopPet({
      onQuestion: (owner, task, questionId) => {
        const focused = applicationWindows().find(win => win.isFocused());
        (focused ?? owner).webContents.send('agent-question-notice', { sessionId: task.sessionId, title: task.title, questionId });
        if (focused || getSettings().enableNotifications !== true) return;
        if (process.platform === 'win32') {
          owner.flashFrame(true);
          owner.once('focus', () => owner.flashFrame(false));
        }
        if (!Notification.isSupported()) return;
        const notice = new Notification({
          title: nativeT('CodeBuddy needs your reply', 'CodeBuddy 等待你回复', 'CodeBuddy 等待你回覆'),
          body: task.title || nativeT('Open the conversation to reply.', '打开对话以回复。', '開啟對話以回覆。'),
          urgency: 'critical',
          timeoutType: 'never',
        });
        notice.on('failed', (_event, error) => log.warn('Question notification failed', error));
        notice.on('click', () => {
          if (owner.isDestroyed()) return;
          if (owner.isMinimized()) owner.restore();
          owner.show();
          owner.focus();
          owner.webContents.send('pet-open-session', task.sessionId);
        });
        notice.show();
      },
      onWorkingChange: (working) => taskWakelock.setWorking(working),
      preload: path.join(__dirname, 'preload.js'),
      rendererUrl: formatUrl(getAppUrl()),
      builtinDirectory: path.join(
        app.isPackaged ? process.resourcesPath : app.getAppPath(),
        app.isPackaged ? 'assets' : 'src/pets/assets'
      ),
      openChat: ({ query, dir, resumeSessionId, noAutoSubmit, images, settings }) =>
        createChat(app, {
          initialMessage: query,
          initialMessageNoAutoSubmit: noAutoSubmit ?? Boolean(query),
          initialImages: images,
          ...(settings ? { viewType: 'settings', settingsSection: 'pets' } : {}),
          dir,
          resumeSessionId,
        }),
    });
  } catch (error) {
    dialog.showErrorBox(
      nativeT(
        `${distro.productName} Error`,
        `${distro.productName} 错误`,
        `${distro.productName} 錯誤`
      ),
      nativeT(
        `Failed to create main window: ${error}`,
        `创建主窗口失败：${error}`,
        `建立主視窗失敗：${error}`
      )
    );
    app.quit();
  }
});

async function getAllowList(): Promise<string[]> {
  if (!process.env.GOOSE_ALLOWLIST) {
    return [];
  }

  const response = await fetch(process.env.GOOSE_ALLOWLIST);

  if (!response.ok) {
    throw new Error(
      `Failed to fetch allowed extensions: ${response.status} ${response.statusText}`
    );
  }

  // Parse the YAML content
  const yamlContent = await response.text();
  const parsedYaml = yaml.parse(yamlContent);

  // Extract the commands from the extensions array
  if (parsedYaml && parsedYaml.extensions && Array.isArray(parsedYaml.extensions)) {
    const commands = parsedYaml.extensions.map(
      (ext: { id: string; command: string }) => ext.command
    );
    console.log(`Fetched ${commands.length} allowed extension commands`);
    return commands;
  } else {
    console.error('Invalid YAML structure:', parsedYaml);
    return [];
  }
}

let harnessQuitFinished = false;
let quitPending = false;
let restartAfterQuit = false;

async function confirmTaskExit(): Promise<boolean> {
  const url = packagedHarnessService?.url ?? (harnessPreview ? process.env.CODEBUDDY_EXTERNAL_BACKEND_URL : undefined);
  if (!url) return true;
  let busy: boolean;
  let unknown = false;
  try {
    const response = await net.fetch(new URL('/status', url).href, {
      headers: { 'X-Secret-Key': process.env.CODEBUDDY_SERVER__SECRET_KEY ?? '' },
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error('Runtime status unavailable');
    const status = await response.json();
    if (typeof status.hasActiveTasks !== 'boolean') throw new Error('Missing runtime activity');
    busy = status.hasActiveTasks;
  } catch {
    busy = true;
    unknown = true;
  }
  if (!busy) return true;
  const choice = dialog.showMessageBoxSync({
    type: 'warning', title: 'CodeBuddy',
    message: unknown
      ? nativeT('Task status is unavailable. Quit CodeBuddy?', '暂时无法确认任务状态，仍要退出吗？', '暫時無法確認任務狀態，仍要結束嗎？')
      : nativeT('A task is running. Quit CodeBuddy?', '有任务正在执行，确认要退出吗？', '有任務正在執行，確認要結束嗎？'),
    detail: nativeT('Quitting may interrupt work in progress.', '退出可能中断正在执行的任务，导致进度丢失。', '結束可能中斷正在執行的任務，導致進度遺失。'),
    buttons: [nativeT('Cancel', '取消', '取消'), nativeT('Quit anyway', '仍然退出', '仍要結束')],
    defaultId: 0, cancelId: 0, noLink: true,
  });
  return choice === 1;
}

app.on('before-quit', (event) => {
  if (harnessQuitFinished) return;
  event.preventDefault();
  if (quitPending) return;
  quitPending = true;
  void (async () => {
    try {
      if (!await confirmTaskExit()) { restartAfterQuit = false; return; }
      const closeRuntime = packagedHarnessService?.close() ??
        startupPromise?.then(({ service }) => service.close(), () => packagedHarnessService?.close());
      await Promise.allSettled([draftStore?.flush(), closeRuntime]);
      harnessQuitFinished = true;
      if (restartAfterQuit) app.relaunch();
      app.quit();
    } finally {
      quitPending = false;
    }
  })();
});

app.on('will-quit', async () => {
  taskWakelock.setEnabled(false);
  const gooseServeLeaseCount = gooseServeLeases.activeLeaseCount();
  if (gooseServeLeaseCount > 0) {
    log.info(`App quitting, cleaning up ${gooseServeLeaseCount} backend lease(s)`);
    await gooseServeLeases.cleanupAll();
  }

  globalShortcut.unregisterAll();
});
