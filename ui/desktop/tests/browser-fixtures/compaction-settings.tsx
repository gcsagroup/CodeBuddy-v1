import React from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { Layers3 } from 'lucide-react';
import { applyThemeTokens } from '../../src/theme/theme-tokens';
import '../../src/styles/main.css';

Object.assign(window, {
  appConfig: { get: () => undefined },
  electron: {
    getSetting: async () => ({}),
    logInfo: () => {},
    on: () => () => {},
    platform: 'win32',
  },
});
if (location.search.includes('dark')) document.documentElement.classList.add('dark');
applyThemeTokens(location.search.includes('dark') ? 'dark' : 'light');
Promise.all([
  import('../../src/components/settings/models/CompactionSettings'),
  import('../../src/components/settings/SettingsMenu'),
  import('../../src/i18n'),
]).then(async ([{ default: CompactionSettings }, { default: SettingsMenu }, { loadMessages }]) => {
  const messages = await loadMessages('zh-CN');
  createRoot(document.getElementById('root')!).render(
    <IntlProvider locale="zh-CN" messages={messages}>
      <main className="min-h-screen bg-background-primary p-6 text-text-primary">
        <div className="mx-auto max-w-3xl">
          <h1 className="mb-6 text-xl font-semibold">模型与运行时</h1>
          <SettingsMenu
            items={[
              {
                id: 'compaction',
                title: '上下文压缩',
                description: '为上下文压缩选择可选的兜底模型。',
                icon: <Layers3 className="h-5 w-5" />,
                keepAlive: true,
                content: (
                  <CompactionSettings
                    providers={[
                      {
                        name: 'fixture',
                        is_configured: true,
                        provider_type: 'Custom',
                        metadata: {
                          name: 'fixture',
                          display_name: 'CodeBuddy LAN',
                          description: 'Synthetic settings fixture',
                          default_model: 'qwen3.8-flash-next-uncensored',
                          model_doc_link: '',
                          config_keys: [],
                          known_models: [
                            { name: 'qwen3.8-flash-next-uncensored', context_limit: 196608 },
                            {
                              name: 'gemma-4-26B-A4B-it-uncensored-FP8-W8A16',
                              context_limit: 65536,
                            },
                          ],
                        },
                      },
                    ]}
                  />
                ),
              },
            ]}
          />
        </div>
      </main>
    </IntlProvider>
  );
});
