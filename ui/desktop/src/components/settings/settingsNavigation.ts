export type SettingsPageId =
  | 'app'
  | 'models'
  | 'chat'
  | 'security'
  | 'memory'
  | 'auth'
  | 'keyboard'
  | 'pets';

export type SettingsGroupId = 'common' | 'ai' | 'connections';

export interface SettingsNavigationItem {
  id: SettingsPageId;
  group: SettingsGroupId;
  label: string;
  description: string;
  keywords: string[];
}

export const settingsNavigationItems: SettingsNavigationItem[] = [
  {
    id: 'app',
    group: 'common',
    label: 'General',
    description: 'Application, appearance, language, notifications, and updates',
    keywords: [
      'application',
      'appearance',
      'language',
      'notification',
      'update',
      'theme',
      '应用',
      '外观',
      '语言',
      '通知',
      '更新',
      '主题',
    ],
  },
  {
    id: 'keyboard',
    group: 'common',
    label: 'Keyboard shortcuts',
    description: 'Global, application, search, and window shortcuts',
    keywords: ['keyboard', 'shortcut', 'hotkey', '键盘', '鍵盤', '快捷键', '快捷鍵'],
  },
  {
    id: 'pets',
    group: 'common',
    label: 'Virtual pets',
    description: 'Desktop companion and task notifications',
    keywords: ['pet', 'companion', '宠物', '寵物'],
  },
  {
    id: 'models',
    group: 'ai',
    label: 'Models and runtime',
    description: 'Active model, local runtime, and custom model connections',
    keywords: [
      'model',
      'provider',
      'local inference',
      'ollama',
      'endpoint',
      'runtime',
      '模型',
      '本地部署',
      '本機部署',
      '端点',
      '端點',
      '运行环境',
      '執行環境',
    ],
  },
  {
    id: 'chat',
    group: 'ai',
    label: 'Behavior and responses',
    description: 'Default mode, CodeBuddy rules, and tool process display',
    keywords: [
      'chat',
      'mode',
      'response',
      'style',
      'response style',
      'global rules',
      'global instructions',
      'codebuddy instructions',
      'codebuddy rules',
      '规则',
      '規則',
      'agents.md',
      '聊天',
      '模式',
      '回答',
      '行为',
      '行為',
      '工具过程',
      '工具過程',
      '全局规则',
      '全域規則',
      '用户规则',
      '使用者規則',
    ],
  },
  {
    id: 'security',
    group: 'connections',
    label: 'Security and permissions',
    description: 'Prompt-injection detection and action-time tool permissions',
    keywords: ['prompt injection', 'permission', 'security', '提示注入', '权限', '權限', '安全'],
  },
  {
    id: 'memory',
    group: 'ai',
    label: 'Memory',
    description: 'Project memory and automatic personalization',
    keywords: ['memory', 'project', 'recall', 'personalization', '记忆', '記憶', '项目', '專案', '习惯', '習慣'],
  },
  {
    id: 'auth',
    group: 'connections',
    label: 'Accounts and credentials',
    description: 'Connected accounts and locally stored credentials',
    keywords: [
      'authentication',
      'credential',
      'account',
      'github',
      'token',
      'secret',
      '账号',
      '帳號',
      '凭据',
      '憑證',
      '密钥',
      '金鑰',
    ],
  },
];

const legacySectionToPage: Record<string, SettingsPageId> = {
  pets: 'pets',
  update: 'app',
  app: 'app',
  models: 'models',
  'local-inference': 'models',
  modes: 'chat',
  styles: 'chat',
  tools: 'chat',
  chat: 'chat',
  security: 'security',
  permissions: 'security',
  advanced: 'chat',
  sharing: 'models',
  prompts: 'chat',
  keyboard: 'keyboard',
  auth: 'auth',
  memory: 'memory',
};

export function resolveSettingsPage(section: string | undefined): SettingsPageId | undefined {
  return section ? legacySectionToPage[section] : undefined;
}

export function matchesSettingsQuery(item: SettingsNavigationItem, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;

  return [item.label, item.description, ...item.keywords].some((value) =>
    value.toLocaleLowerCase().includes(normalized)
  );
}
