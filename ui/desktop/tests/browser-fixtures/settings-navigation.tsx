import React from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { defaultKeyboardShortcuts } from '../../src/utils/settings';
import '../../src/styles/main.css';

Object.assign(window, {
  appConfig: { get: () => undefined },
  electron: { getSetting: async () => defaultKeyboardShortcuts, logInfo: () => {},
    getAppVersion: async () => 'fixture', on: () => () => {}, platform: 'win32' },
});
Promise.all([import('../../src/components/settings/SettingsView'), import('../../src/i18n')])
  .then(async ([{ default: SettingsView }, { loadMessages }]) => {
    const messages = await loadMessages('zh-CN');
    createRoot(document.getElementById('root')!).render(
      <IntlProvider locale="zh-CN" messages={messages}>
        <SettingsView onClose={() => {}} setView={() => {}} viewOptions={{ section: 'keyboard' }} />
      </IntlProvider>
    );
  });
