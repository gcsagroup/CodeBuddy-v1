import type { DesktopControlState } from './desktopControl';
import type { PetRequest, PetSnapshot } from './pets/petTypes';
import type { DraftRequest, DraftSnapshot } from './drafts/types';
import type { GitHubCliStatus, GitHubCliChallenge, GitHubCliPoll } from './github/githubCliTypes';
import type {
  PanelRequest,
  PanelReply,
  PanelLocalSelection,
  WebLinkMenuRequest,
  PanelTabMenuRequest,
} from './workspace-panel/workspacePanelTypes';
import Electron, { contextBridge, ipcRenderer, webUtils } from 'electron';
import { Recipe } from './recipe';
import type { GooseApp } from './types/apps';
import type { Settings, SettingKey } from './utils/settings';
import type {
  CodeProConfirmableWorkspaceState,
  CodeProWorkspaceConfirmation,
  CodeProWorkspaceInspection,
} from './codepro/projectWorkspace';
import { defaultSettings } from './utils/settings';

// Mapping from settings keys to their old localStorage keys for lazy migration
const localStorageKeyMap: Partial<Record<SettingKey, string>> = {
  theme: 'theme',
  useSystemTheme: 'use_system_theme',
  responseStyle: 'response_style',
  showPricing: 'show_pricing',
  seenAnnouncementIds: 'seenAnnouncementIds',
};

// Parse localStorage value based on the setting key
function parseLocalStorageValue<K extends SettingKey>(
  key: K,
  rawValue: string
): Settings[K] | null {
  try {
    switch (key) {
      case 'theme':
        return (rawValue === 'dark' || rawValue === 'light' ? rawValue : null) as Settings[K];
      case 'useSystemTheme':
        return (rawValue === 'true') as unknown as Settings[K];
      case 'responseStyle':
        return rawValue as Settings[K];
      case 'showPricing':
        return (rawValue === 'true') as unknown as Settings[K];
      case 'seenAnnouncementIds':
        return JSON.parse(rawValue) as Settings[K];
      default:
        return null;
    }
  } catch {
    return null;
  }
}

interface NotificationData {
  title: string;
  body: string;
}

interface MessageBoxOptions {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning';
  buttons?: string[];
  defaultId?: number;
  title?: string;
  message: string;
  detail?: string;
}

interface MessageBoxResponse {
  response: number;
  checkboxChecked?: boolean;
}

interface SaveDialogOptions {
  title?: string;
  defaultDirectory?: 'desktop';
  defaultPath?: string;
  buttonLabel?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
  message?: string;
  nameFieldLabel?: string;
  showsTagField?: boolean;
}

interface SaveDialogResponse {
  canceled: boolean;
  filePath?: string;
}

interface FileResponse {
  file: string;
  filePath: string;
  error: string | null;
  found: boolean;
}

const config = JSON.parse(process.argv.find((arg) => arg.startsWith('{')) || '{}');

interface UpdaterEvent {
  event: string;
  data?: unknown;
}

export interface CreateChatWindowOptions {
  query?: string;
  dir?: string;
  version?: string;
  resumeSessionId?: string;
  viewType?: string;
  recipeId?: string;
  workspaceMode?: 'code' | 'codepro';
  workspaceBinding?: 'unbound';
}

// Define the API types in a single place
type ElectronAPI = {
  newTaskDraft: (request: DraftRequest) => Promise<DraftSnapshot>;
  desktopPet: (request: PetRequest) => Promise<PetSnapshot>;
  desktopControl: (state: DesktopControlState | null) => void;
  onDesktopControlCancel: (callback: (state: DesktopControlState) => void) => () => void;
  onDesktopFeedbackError: (callback: (message: string) => void) => () => void;
  petSignal: (channel: 'pet-hit-test' | 'pet-task' | 'pet-read' | 'pet-message-result', payload: unknown) => void;
  workspacePanel: (request: PanelRequest) => Promise<PanelReply>;
  openPastedText: (text: string) => Promise<{ opened: boolean }>;
  workspaceOpenLocal: (kind: 'file' | 'directory') => Promise<PanelLocalSelection | null>;
  workspaceTabMenu: (request: PanelTabMenuRequest) => Promise<PanelReply>;
  webLinkMenu: (request: WebLinkMenuRequest) => Promise<{ action: 'preview' | null }>;
  platform: string;
  arch: string;
  requestNetworkAccess: () => Promise<boolean>;
  startupModelConfigured: () => Promise<boolean>;
  reactReady: () => void;
  getConfig: () => Record<string, unknown>;
  hideWindow: () => void;
  directoryChooser: (multiple?: boolean) => Promise<Electron.OpenDialogReturnValue>;
  defaultCodeProWorkspacePath: () => Promise<string>;
  inspectCodeProWorkspace: (input: {
    prompt: string;
    selectedWorkingDir: string;
  }) => Promise<CodeProWorkspaceInspection[]>;
  confirmCodeProWorkspace: (input: {
    normalizedPath: string;
    expectedState: CodeProConfirmableWorkspaceState;
    expectedIdentity: string;
  }) => Promise<CodeProWorkspaceConfirmation>;
  createChatWindow: (options?: CreateChatWindowOptions) => void;
  logInfo: (txt: string) => void;
  showNotification: (data: NotificationData) => void;
  showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxResponse>;
  showSaveDialog: (options: SaveDialogOptions) => Promise<SaveDialogResponse>;
  openInChrome: (url: string) => void;
  reloadApp: () => void;
  checkForOllama: () => Promise<boolean>;
  selectFileOrDirectory: (defaultPath?: string) => Promise<string | null>;
  selectRootCleanupTarget: (rootPath: string) => Promise<string | null>;
  selectImportSessionFile: () => Promise<{
    filePath: string;
    contents: string;
    error?: string;
  } | null>;
  getBinaryPath: (binaryName: string) => Promise<string>;
  readFile: (directory: string) => Promise<FileResponse>;
  readWorkspaceFile: (workspaceRoot: string, filePath: string) => Promise<FileResponse>;
  writeFile: (directory: string, content: string) => Promise<boolean>;
  ensureDirectory: (dirPath: string) => Promise<boolean>;
  listFiles: (dirPath: string, extension?: string) => Promise<string[]>;
  getAllowedExtensions: () => Promise<string[]>;
  getPathForFile: (file: File) => string;
  setMenuBarIcon: (show: boolean) => Promise<boolean>;
  getMenuBarIconState: () => Promise<boolean>;
  setDockIcon: (show: boolean) => Promise<boolean>;
  getDockIconState: () => Promise<boolean>;
  getSetting: <K extends SettingKey>(key: K) => Promise<Settings[K]>;
  setSetting: <K extends SettingKey>(key: K, value: Settings[K]) => Promise<void>;
  githubCliStatus: () => Promise<GitHubCliStatus>;
  githubCliLogout: (login: string) => Promise<GitHubCliStatus>;
  githubCliLoginStart: () => Promise<GitHubCliChallenge>;
  githubCliLoginPoll: (flowId: string) => Promise<GitHubCliPoll>;
  githubCliLoginCancel: (flowId: string) => Promise<void>;
  getSecretKey: () => Promise<string | null>;
  getAcpUrl: () => Promise<string | null>;
  setWakelock: (enable: boolean) => Promise<boolean>;
  getWakelockState: () => Promise<boolean>;
  setSpellcheck: (enable: boolean) => Promise<boolean>;
  getSpellcheckState: () => Promise<boolean>;
  openNotificationsSettings: () => Promise<boolean>;
  isAnyWindowFocused: () => Promise<boolean>;
  getIsFullScreen: () => Promise<boolean>;
  getWindowMenu: () => Promise<Array<{ index: number; label: string; enabled: boolean }>>;
  openWindowMenu: (index: number, x: number, y: number) => Promise<void>;
  setTitlebarTheme: (theme: 'light' | 'dark') => Promise<void>;
  onMouseBackButtonClicked: (callback: () => void) => void;
  offMouseBackButtonClicked: (callback: () => void) => void;
  on: (
    channel: string,
    callback: (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
  ) => (() => void) | void;
  off: (
    channel: string,
    callback: (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
  ) => void;
  emit: (channel: string, ...args: unknown[]) => void;
  broadcastThemeChange: (themeData: {
    mode: string;
    useSystemTheme: boolean;
    theme: string;
    tokensUpdated?: boolean;
  }) => void;
  openExternal: (url: string) => Promise<void>;
  // Update-related functions
  getVersion: () => string;
  checkForUpdates: (
    channel?: import('./update/types').UpdateChannel
  ) => Promise<import('./update/types').UpdateState>;
  downloadUpdate: () => Promise<import('./update/types').UpdateState>;
  installUpdate: () => Promise<import('./update/types').UpdateState>;
  cancelUpdate: () => Promise<void>;
  restartApp: () => void;
  onUpdaterEvent: (callback: (event: UpdaterEvent) => void) => () => void;
  getUpdateState: () => Promise<import('./update/types').UpdateState>;
  isUsingGitHubFallback: () => Promise<boolean>;
  getAutoDownloadDisabled: () => Promise<boolean>;
  // Recipe warning functions
  closeWindow: () => void;
  hasAcceptedRecipeBefore: (recipe: Recipe) => Promise<boolean>;
  recordRecipeHash: (recipe: Recipe) => Promise<boolean>;
  openDirectoryInExplorer: (directoryPath: string) => Promise<boolean>;
  launchApp: (app: GooseApp) => Promise<void>;
  refreshApp: (app: GooseApp) => Promise<void>;
  closeApp: (appName: string) => Promise<void>;
  addRecentDir: (dir: string) => Promise<boolean>;
  listRecentDirs: () => Promise<string[]>;
  listGitWorktreeDirs: (dir: string) => Promise<string[]>;
};

type AppConfigAPI = {
  get: (key: string) => unknown;
  getAll: () => Record<string, unknown>;
};

const electronAPI: ElectronAPI = {
  newTaskDraft: (request) => ipcRenderer.invoke('new-task-draft', request),
  desktopPet: (request) => ipcRenderer.invoke('desktop-pet', request),
  desktopControl: (state) => ipcRenderer.send('desktop-control-state', state),
  onDesktopFeedbackError: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string) => callback(message);
    ipcRenderer.on('desktop-control-feedback-error', listener);
    return () => ipcRenderer.removeListener('desktop-control-feedback-error', listener);
  },
  onDesktopControlCancel: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: DesktopControlState) =>
      callback(state);
    ipcRenderer.on('desktop-control-cancel', listener);
    return () => ipcRenderer.removeListener('desktop-control-cancel', listener);
  },
  workspacePanel: (request) => ipcRenderer.invoke('workspace-panel', request),
  openPastedText: (text) => ipcRenderer.invoke('open-pasted-text', text),
  workspaceTabMenu: (request) => ipcRenderer.invoke('workspace-tab-menu', request),
  webLinkMenu: (request) => ipcRenderer.invoke('web-link-menu', request),
  platform: process.platform,
  arch: process.arch,
  requestNetworkAccess: () => ipcRenderer.invoke('request-network-access'),
  startupModelConfigured: () => ipcRenderer.invoke('startup-model-configured'),
  reactReady: () => ipcRenderer.send('react-ready'),
  getConfig: () => {
    if (!config || Object.keys(config).length === 0) {
      console.warn(
        'No config provided by main process. This may indicate an initialization issue.'
      );
    }
    return config;
  },
  hideWindow: () => ipcRenderer.send('hide-window'),
  directoryChooser: (multiple = false) => ipcRenderer.invoke('directory-chooser', multiple),
  defaultCodeProWorkspacePath: () => ipcRenderer.invoke('default-codepro-workspace-path'),
  inspectCodeProWorkspace: (input) => ipcRenderer.invoke('inspect-codepro-workspace', input),
  confirmCodeProWorkspace: (input) => ipcRenderer.invoke('confirm-codepro-workspace', input),
  createChatWindow: (options?: CreateChatWindowOptions) =>
    ipcRenderer.send('create-chat-window', options || {}),
  logInfo: (txt: string) => ipcRenderer.send('logInfo', txt),
  showNotification: (data: NotificationData) => ipcRenderer.send('notify', data),
  showMessageBox: (options: MessageBoxOptions) => ipcRenderer.invoke('show-message-box', options),
  showSaveDialog: (options: SaveDialogOptions) => ipcRenderer.invoke('show-save-dialog', options),
  openInChrome: (url: string) => ipcRenderer.send('open-in-chrome', url),
  reloadApp: () => ipcRenderer.send('reload-app'),
  checkForOllama: () => ipcRenderer.invoke('check-ollama'),

  selectFileOrDirectory: (defaultPath?: string) =>
    ipcRenderer.invoke('select-file-or-directory', defaultPath),
  workspaceOpenLocal: (kind: 'file' | 'directory') => ipcRenderer.invoke('workspace-open-local', kind),
  selectRootCleanupTarget: (rootPath: string) =>
    ipcRenderer.invoke('select-root-cleanup-target', rootPath),
  selectImportSessionFile: () => ipcRenderer.invoke('select-import-session-file'),
  getBinaryPath: (binaryName: string) => ipcRenderer.invoke('get-binary-path', binaryName),
  readFile: (filePath: string) => ipcRenderer.invoke('read-file', filePath),
  readWorkspaceFile: (workspaceRoot: string, filePath: string) =>
    ipcRenderer.invoke('read-workspace-file', workspaceRoot, filePath),
  writeFile: (filePath: string, content: string) =>
    ipcRenderer.invoke('write-file', filePath, content),
  ensureDirectory: (dirPath: string) => ipcRenderer.invoke('ensure-directory', dirPath),
  listFiles: (dirPath: string, extension?: string) =>
    ipcRenderer.invoke('list-files', dirPath, extension),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  getAllowedExtensions: () => ipcRenderer.invoke('get-allowed-extensions'),
  setMenuBarIcon: (show: boolean) => ipcRenderer.invoke('set-menu-bar-icon', show),
  getMenuBarIconState: () => ipcRenderer.invoke('get-menu-bar-icon-state'),
  setDockIcon: (show: boolean) => ipcRenderer.invoke('set-dock-icon', show),
  getDockIconState: () => ipcRenderer.invoke('get-dock-icon-state'),
  getSetting: async <K extends SettingKey>(key: K): Promise<Settings[K]> => {
    try {
      // Check for localStorage value first (lazy migration)
      const localStorageKey = localStorageKeyMap[key];
      if (localStorageKey) {
        const rawValue = localStorage.getItem(localStorageKey);
        if (rawValue !== null) {
          const parsed = parseLocalStorageValue(key, rawValue);
          if (parsed !== null) {
            return parsed;
          }
        }
      }
      return await ipcRenderer.invoke('get-setting', key);
    } catch (error) {
      console.error(`Failed to get setting '${key}', using default`, error);
      return defaultSettings[key];
    }
  },
  setSetting: async <K extends SettingKey>(key: K, value: Settings[K]): Promise<void> => {
    // Clear any localStorage version when writing
    const localStorageKey = localStorageKeyMap[key];
    if (localStorageKey) {
      localStorage.removeItem(localStorageKey);
    }
    return ipcRenderer.invoke('set-setting', key, value);
  },
  githubCliStatus: () => ipcRenderer.invoke('github-cli-status'),
  githubCliLogout: (login: string) => ipcRenderer.invoke('github-cli-logout', login),
  githubCliLoginStart: () => ipcRenderer.invoke('github-cli-login-start'),
  githubCliLoginPoll: (flowId: string) => ipcRenderer.invoke('github-cli-login-poll', flowId),
  githubCliLoginCancel: (flowId: string) => ipcRenderer.invoke('github-cli-login-cancel', flowId),
  getSecretKey: () => ipcRenderer.invoke('get-secret-key'),
  getAcpUrl: () => ipcRenderer.invoke('get-acp-url'),
  setWakelock: (enable: boolean) => ipcRenderer.invoke('set-wakelock', enable),
  getWakelockState: () => ipcRenderer.invoke('get-wakelock-state'),
  setSpellcheck: (enable: boolean) => ipcRenderer.invoke('set-spellcheck', enable),
  getSpellcheckState: () => ipcRenderer.invoke('get-spellcheck-state'),
  openNotificationsSettings: () => ipcRenderer.invoke('open-notifications-settings'),
  isAnyWindowFocused: () => ipcRenderer.invoke('is-any-window-focused'),
  getIsFullScreen: () => ipcRenderer.invoke('get-is-fullscreen'),
  getWindowMenu: () => ipcRenderer.invoke('window-menu-list'),
  openWindowMenu: (index, x, y) => ipcRenderer.invoke('window-menu-open', index, x, y),
  setTitlebarTheme: (theme) => ipcRenderer.invoke('window-titlebar-theme', theme),
  onMouseBackButtonClicked: (callback: () => void) => {
    // Wrapper that ignores the event parameter.
    const wrappedCallback = (_event: Electron.IpcRendererEvent) => callback();
    ipcRenderer.on('mouse-back-button-clicked', wrappedCallback);
    return wrappedCallback;
  },
  offMouseBackButtonClicked: (callback: () => void) => {
    ipcRenderer.removeListener('mouse-back-button-clicked', callback);
  },
  on: (
    channel: string,
    callback: (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
  ) => {
    ipcRenderer.on(channel, callback);
    // Close over the original proxy: callbacks crossing contextBridge again
    // are not a reliable identity for removing an existing listener.
    return () => ipcRenderer.off(channel, callback);
  },
  off: (
    channel: string,
    callback: (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
  ) => {
    ipcRenderer.off(channel, callback);
  },
  emit: (channel: string, ...args: unknown[]) => {
    ipcRenderer.emit(channel, ...args);
  },
  petSignal: (channel: 'pet-hit-test' | 'pet-task' | 'pet-read' | 'pet-message-result', payload: unknown) => {
    if (channel === 'pet-hit-test' || channel === 'pet-task' || channel === 'pet-read' || channel === 'pet-message-result')
      ipcRenderer.send(channel, payload);
  },
  broadcastThemeChange: (themeData: {
    mode: string;
    useSystemTheme: boolean;
    theme: string;
    tokensUpdated?: boolean;
  }) => {
    ipcRenderer.send('broadcast-theme-change', themeData);
  },
  openExternal: (url: string): Promise<void> => {
    return ipcRenderer.invoke('open-external', url);
  },
  getVersion: (): string => {
    return config.GOOSE_VERSION || ipcRenderer.sendSync('get-app-version') || '';
  },
  checkForUpdates: (channel = 'preview') => {
    return ipcRenderer.invoke('check-for-updates', channel);
  },
  downloadUpdate: () => {
    return ipcRenderer.invoke('download-update');
  },
  installUpdate: () => {
    return ipcRenderer.invoke('install-update');
  },
  cancelUpdate: () => ipcRenderer.invoke('cancel-update'),
  restartApp: (): void => {
    ipcRenderer.send('restart-app');
  },
  onUpdaterEvent: (callback: (event: UpdaterEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: UpdaterEvent) => callback(data);
    ipcRenderer.on('updater-event', listener);
    return () => ipcRenderer.removeListener('updater-event', listener);
  },
  getUpdateState: () => {
    return ipcRenderer.invoke('get-update-state');
  },
  isUsingGitHubFallback: (): Promise<boolean> => {
    return ipcRenderer.invoke('is-using-github-fallback');
  },
  getAutoDownloadDisabled: (): Promise<boolean> => {
    return ipcRenderer.invoke('get-auto-download-disabled');
  },
  closeWindow: () => ipcRenderer.send('close-window'),
  hasAcceptedRecipeBefore: (recipe: Recipe) =>
    ipcRenderer.invoke('has-accepted-recipe-before', recipe),
  recordRecipeHash: (recipe: Recipe) => ipcRenderer.invoke('record-recipe-hash', recipe),
  openDirectoryInExplorer: (directoryPath: string) =>
    ipcRenderer.invoke('open-directory-in-explorer', directoryPath),
  launchApp: (app: GooseApp) => ipcRenderer.invoke('launch-app', app),
  refreshApp: (app: GooseApp) => ipcRenderer.invoke('refresh-app', app),
  closeApp: (appName: string) => ipcRenderer.invoke('close-app', appName),
  addRecentDir: (dir: string) => ipcRenderer.invoke('add-recent-dir', dir),
  listRecentDirs: () => ipcRenderer.invoke('list-recent-dirs'),
  listGitWorktreeDirs: (dir: string) => ipcRenderer.invoke('list-git-worktree-dirs', dir),
};

function getAppLocale(): unknown {
  try {
    return ipcRenderer.sendSync('get-app-locale') ?? config.GOOSE_LOCALE;
  } catch {
    return config.GOOSE_LOCALE;
  }
}

const appConfigAPI: AppConfigAPI = {
  get: (key: string) => (key === 'GOOSE_LOCALE' ? getAppLocale() : config[key]),
  getAll: () => ({ ...config, GOOSE_LOCALE: getAppLocale() }),
};

// Expose the APIs
contextBridge.exposeInMainWorld('electron', electronAPI);
contextBridge.exposeInMainWorld('appConfig', appConfigAPI);

// Type declaration for TypeScript
declare global {
  interface Window {
    electron: ElectronAPI;
    appConfig: AppConfigAPI;
  }
}
