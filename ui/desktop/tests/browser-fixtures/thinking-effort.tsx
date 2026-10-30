import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import type { ThinkingEffort, ModelThinkingSettings } from '../../src/types/providers';
import '../../src/styles/main.css';
import { applyThemeTokens } from '../../src/theme/theme-tokens';

const params = new URLSearchParams(location.search);
const useSlider = params.has('slider');
const dark = params.has('dark');
document.documentElement.classList.toggle('dark', dark);
applyThemeTokens(dark ? 'dark' : 'light');

Object.assign(window, {
  appConfig: { get: () => undefined },
  electron: { platform: 'win32', logInfo: () => {} },
});
Promise.all([import('../../src/components/ThinkingEffortPicker'), import('../../src/i18n')]).then(
  async ([{ ThinkingEffortPicker }, { loadMessages }]) => {
    const messages = await loadMessages('zh-CN');
    const fixture = (
      window as unknown as { thinkingFixture?: { name: string; settings: ModelThinkingSettings } }
    ).thinkingFixture;
    function Fixture() {
      const [value, setValue] = useState<ThinkingEffort>(fixture?.settings.value ?? 'xhigh');
      const [selectingModel, setSelectingModel] = useState(false);
      if (useSlider)
        return (
          <IntlProvider locale="zh-CN" messages={messages}>
            <main style={{ minHeight: '100vh', padding: '240px 24px 24px' }}>
              <ThinkingEffortPicker
                presentation="slider"
                settings={{
                  ...(fixture?.settings ?? {
                    options: ['low', 'medium', 'high', 'xhigh', 'max'],
                    toggle: false,
                  }),
                  value,
                }}
                onChange={setValue}
                modelLabel={fixture?.name ?? 'gpt-6.1-sol'}
                onSelectModel={() => setSelectingModel(true)}
                triggerContent={<span className="truncate">{fixture?.name ?? 'gpt-6.1-sol'}</span>}
              />
              {selectingModel && <p role="status">模型选择已打开</p>}
            </main>
          </IntlProvider>
        );
      return (
        <IntlProvider locale="zh-CN" messages={messages}>
          <main style={{ width: 340, margin: '80px auto', padding: 20 }}>
            <h1>{fixture?.name ?? 'Qwen3.8-27B-direct-A-best15-FP4'}</h1>
            <ThinkingEffortPicker
              settings={{
                ...(fixture?.settings ?? {
                  options: ['off', 'low', 'medium', 'xhigh'],
                  toggle: false,
                }),
                value,
              }}
              onChange={setValue}
              showLabel
            />
            <ThinkingEffortPicker
              settings={{ options: [], value: null, toggle: false }}
              onChange={() => {}}
              showLabel
            />
          </main>
        </IntlProvider>
      );
    }
    createRoot(document.getElementById('root')!).render(<Fixture />);
  }
);
