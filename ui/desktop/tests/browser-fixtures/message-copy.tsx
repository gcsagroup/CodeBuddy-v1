import React from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import '../../src/styles/main.css';
import { applyThemeTokens } from '../../src/theme/theme-tokens';

Object.assign(window, {
  appConfig: { get: () => undefined },
  electron: { platform: 'win32', logInfo: () => {}, on: () => () => {} },
});
applyThemeTokens('light');
document.documentElement.classList.add('light');
const text = new URLSearchParams(location.search).get('text') ?? '';
const { default: UserMessage } = await import('../../src/components/UserMessage');
createRoot(document.getElementById('root')!).render(
  <IntlProvider locale="en" messages={{}}>
    <main style={{ maxWidth: 850, margin: '40px auto', padding: 20 }}>
      <UserMessage
        message={{
          id: 'copy-regression',
          role: 'user',
          created: 1,
          metadata: { userVisible: true, agentVisible: true },
          content: [{ type: 'text', text }],
        }}
      />
      <label htmlFor="paste-result">Paste result</label>
      <textarea id="paste-result" style={{ width: '100%', height: 160 }} />
    </main>
  </IntlProvider>
);
