import React from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import zhCN from '../../src/i18n/messages/zh-CN.json';
import '../../src/styles/main.css';
import { applyThemeTokens } from '../../src/theme/theme-tokens';
import type { UpdateState } from '../../src/update/types';
applyThemeTokens('light');
let callback: (event: { event: string; data: UpdateState }) => void;
let attempts = 0;
const ready: UpdateState = { phase: 'ready', channel: 'preview', currentVersion: '1.43.17', version: '1.43.18' };
Object.assign(window, { electron: {
  getVersion: () => ready.currentVersion,
  getUpdateState: async () => ready,
  onUpdaterEvent: (fn: typeof callback) => { callback = fn; return () => {}; },
  installUpdate: async () => {
    if (++attempts === 1) return ready;
    const installing: UpdateState = { ...ready, phase: 'installing' };
    callback({ event: 'state', data: installing });
    return installing;
  },
} });
import('../../src/components/settings/app/UpdateSection').then(({ default: UpdateSection }) => {
  createRoot(document.getElementById('root')!).render(
    <IntlProvider locale="zh-CN" messages={Object.fromEntries(Object.entries(zhCN).map(([k, v]) => [k, v.defaultMessage]))}>
      <main className="max-w-2xl mx-auto p-6"><h1>CodeBuddy 更新</h1><UpdateSection /></main>
    </IntlProvider>
  );
});
