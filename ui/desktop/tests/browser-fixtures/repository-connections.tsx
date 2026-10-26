import React from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { MemoryRouter } from 'react-router-dom';
import zhCN from '../../src/i18n/messages/zh-CN.json';
import '../../src/styles/main.css';
import { applyThemeTokens } from '../../src/theme/theme-tokens';
applyThemeTokens('light');
document.documentElement.classList.add('light');
const params = new URLSearchParams(location.search);
Object.assign(window, {
  appConfig: { get: () => undefined },
  electron: {
    platform: 'win32',
    logInfo: () => {},
    on: () => () => {},
    githubCliStatus: async () =>
      params.get('state') === 'signed-out'
        ? { state: 'disconnected' }
        : { state: 'connected', login: 'preview-colleague' },
    githubCliLoginStart: async () => ({
      flowId: 'fixture',
      userCode: 'TEST-CODE',
      expiresAt: Date.now() + 60000,
    }),
    githubCliLoginPoll: async () => ({ state: 'pending' }),
    githubCliLoginCancel: async () => {},
    githubCliLogout: async () => ({ state: 'disconnected' }),
    openExternal: async () => {},
  },
});
Promise.all([
  import('../../src/components/toolbox/ToolboxView'),
  import('../../src/components/settings/auth/GitHubAuthCard'),
]).then(([{ default: Toolbox }, { default: Account }]) => {
  createRoot(document.getElementById('root')!).render(
    <IntlProvider
      locale="zh-CN"
      messages={Object.fromEntries(Object.entries(zhCN).map(([k, v]) => [k, v.defaultMessage]))}
    >
      <MemoryRouter>
        {params.get('view') === 'settings' ? (
          <main className="max-w-2xl mx-auto p-6">
            <Account />
          </main>
        ) : (
          <Toolbox />
        )}
      </MemoryRouter>
    </IntlProvider>
  );
});
