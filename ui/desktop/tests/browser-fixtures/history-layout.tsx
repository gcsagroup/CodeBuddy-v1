import React from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import zhCN from '../../src/i18n/messages/zh-CN.json';
import '../../src/styles/main.css';
import { applyThemeTokens } from '../../src/theme/theme-tokens';
applyThemeTokens('light');
document.documentElement.classList.add('light');
Object.assign(window, {
  appConfig: { get: () => undefined },
  electron: { platform: 'win32', getConfig: () => ({}), logInfo: () => {} },
});
import('../../src/components/sessions/SessionListView').then(({ default: History }) => {
  createRoot(document.getElementById('root')!).render(
    <IntlProvider locale="zh-CN" messages={Object.fromEntries(Object.entries(zhCN).map(([k,v]) => [k,v.defaultMessage]))}>
      <History workspaceMode="unified" onSelectSession={() => {}} />
    </IntlProvider>
  );
});
