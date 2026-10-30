import React from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { ToastContainer } from 'react-toastify';
import '../../src/styles/main.css';
import { applyThemeTokens } from '../../src/theme/theme-tokens';

const bridge = window as unknown as {
  chooseLogDestination: () => Promise<{ canceled: boolean; filePath?: string }>;
  saveSessionLog: (path: string, content: string) => Promise<boolean>;
};
Object.assign(window, {
  appConfig: { get: () => undefined },
  electron: {
    platform: 'win32',
    logInfo: () => {},
    on: () => () => {},
    getAcpUrl: async () => new URLSearchParams(location.search).get('ws'),
    showSaveDialog: () => bridge.chooseLogDestination(),
    writeFile: (path: string, content: string) => bridge.saveSessionLog(path, content),
  },
});
applyThemeTokens('light');
document.documentElement.classList.add('light');
const { SessionActionsContextMenu } = await import('../../src/components/SessionActionsHeader');
createRoot(document.getElementById('root')!).render(
  <IntlProvider locale="en" messages={{}}>
    <main style={{ padding: 60 }}>
      <SessionActionsContextMenu session={{ id: 'product-export', name: 'Export acceptance' }}>
        <div>Export acceptance</div>
      </SessionActionsContextMenu>
      <ToastContainer />
    </main>
  </IntlProvider>
);
