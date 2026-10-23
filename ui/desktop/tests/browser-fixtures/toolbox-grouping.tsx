import React from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { MemoryRouter } from 'react-router-dom';
import zhCN from '../../src/i18n/messages/zh-CN.json';
import '../../src/styles/main.css';
import { applyThemeTokens } from '../../src/theme/theme-tokens';
applyThemeTokens('light');
document.documentElement.classList.add('light');
Object.assign(window, {
  appConfig: { get: () => undefined },
  electron: { platform: 'win32', logInfo: () => {}, on: () => () => {} },
});
import('../../src/components/toolbox/ToolboxView').then(({ default: ToolboxView }) => {
  createRoot(document.getElementById('root')!).render(
    <IntlProvider
      locale="zh-CN"
      messages={Object.fromEntries(
        Object.entries(zhCN).map(([key, value]) => [key, value.defaultMessage])
      )}
    >
      <MemoryRouter>
        <ToolboxView />
      </MemoryRouter>
    </IntlProvider>
  );
});
