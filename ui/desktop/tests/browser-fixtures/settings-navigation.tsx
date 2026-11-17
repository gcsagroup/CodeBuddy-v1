import React from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { defaultKeyboardShortcuts, defaultSettings } from '../../src/utils/settings';
import { applyThemeTokens } from '../../src/theme/theme-tokens';
import '../../src/styles/main.css';

applyThemeTokens(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

const rulesFixture = new URLSearchParams(location.search).has('behaviorFixture');

Object.assign(window, {
  appConfig: {
    get: (key: string) =>
      rulesFixture && key === 'CODEBUDDY_HOME'
        ? 'C:/Users/browser-fixture/.CodeBuddy/settings-layout-validation'
        : undefined,
  },
  electron: {
    getSetting: async (key: string) =>
      key === 'keyboardShortcuts'
        ? defaultKeyboardShortcuts
        : defaultSettings[key as keyof typeof defaultSettings],
    setSetting: async () => {},
    readFile: async (path: string) => path.endsWith('/AGENTS.md')
      ? { found: true, file: '请用简体中文回复。', error: '' }
      : { found: false, file: '', error: '' },
    writeFile: async () => true,
    getMenuBarIconState: async () => true,
    getWakelockState: async () => false,
    off: () => {},
    broadcastThemeChange: () => {},
    desktopPet: async () => ({
      pets: [],
      errors: [],
      creationDirectory: '',
      preferences: { selectedId: null, visible: false, size: 128, reducedMotion: false },
    }),
    logInfo: () => {},
    getAppVersion: async () => 'fixture',
    getVersion: () => '1.0.0',
    getUpdateState: async () => ({ phase: 'idle', channel: 'preview', currentVersion: '1.0.0' }),
    onUpdaterEvent: () => () => {},
    on: () => () => {},
    platform: 'win32',
  },
});
Promise.all([
  import('../../src/components/settings/SettingsView'),
  import('../../src/i18n'),
  import('../../src/components/ModelAndProviderContext'),
  import('../../src/contexts/ThemeContext'),
]).then(
  async ([
    { default: SettingsView },
    { loadMessages },
    { ModelAndProviderProvider },
    { ThemeProvider },
  ]) => {
    const messages = await loadMessages('zh-CN');
    createRoot(document.getElementById('root')!).render(
      <IntlProvider locale="zh-CN" messages={messages}>
        <ThemeProvider>
          <ModelAndProviderProvider>
            <SettingsView
              onClose={() => {}}
              setView={() => {}}
              viewOptions={{ section: 'keyboard' }}
            />
          </ModelAndProviderProvider>
        </ThemeProvider>
      </IntlProvider>
    );
  }
);
