import React from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { applyThemeTokens } from '../../src/theme/theme-tokens';
import '../../src/styles/main.css';

applyThemeTokens(new URLSearchParams(location.search).has('dark') ? 'dark' : 'light');
// Only transport and file access are fixtures; render the shipped component and CSS.
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="360"><rect width="600" height="360" fill="#dbeafe"/><path d="M0 250L170 70L330 250L480 120L600 250V360H0Z" fill="#64748b"/><path d="M0 270H600V360H0Z" fill="#7dd3fc"/></svg>';
Object.assign(window, {
  appConfig: { get: (key: string) => key === 'GOOSE_LOCALE' ? 'zh-CN' : undefined },
  electron: {
    platform: 'win32', logInfo: () => {},
    workspacePanel: async () => ({ document: { media: { kind: 'image', mimeType: 'image/svg+xml', url: `data:image/svg+xml,${encodeURIComponent(svg)}` } } }),
  },
});
function Location() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}
Promise.all([import('../../src/components/media-library/MediaLibrary'), import('../../src/i18n')])
  .then(async ([{ MediaLibrary }, { loadMessages }]) => {
    createRoot(document.getElementById('root')!).render(
      <IntlProvider locale="zh-CN" messages={await loadMessages('zh-CN')}>
        <MemoryRouter initialEntries={['/media-library']}>
          <div style={{ height: 'calc(100vh - 24px)' }}><MediaLibrary /></div>
          <Location />
        </MemoryRouter>
      </IntlProvider>
    );
  });
