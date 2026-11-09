import React from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import CompactionModelSettings from '../../src/components/settings/models/CompactionModelSettings';
import type { ProviderDetails } from '../../src/types/providers';
import { applyThemeTokens } from '../../src/theme/theme-tokens';

const dark = new URLSearchParams(window.location.search).has('dark');
applyThemeTokens(dark ? 'dark' : 'light');
document.documentElement.classList.add(dark ? 'dark' : 'light');
document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
const providers = [
  {
    name: 'local',
    is_configured: true,
    category: 'model',
    metadata: {
      display_name: '本地模型连接',
      known_models: [{ name: 'gemma-4-26B-A4B-it-uncensored-FP8-W8A16' }],
    },
  },
] as ProviderDetails[];
createRoot(document.getElementById('root')!).render(
  <IntlProvider locale="zh-CN" defaultLocale="en" messages={{}}>
    <main className="mx-auto max-w-2xl p-5 font-sans text-text-primary">
      <CompactionModelSettings providers={providers} />
    </main>
  </IntlProvider>
);
