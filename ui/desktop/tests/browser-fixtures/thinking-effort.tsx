import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import type { ThinkingEffort, ModelThinkingSettings } from '../../src/types/providers';
import '../../src/styles/main.css';

Object.assign(window, { appConfig: { get: () => undefined }, electron: { platform: 'win32', logInfo: () => {} } });
Promise.all([import('../../src/components/ThinkingEffortPicker'), import('../../src/i18n')])
  .then(async ([{ ThinkingEffortPicker }, { loadMessages }]) => {
    const messages = await loadMessages('zh-CN');
    const fixture = (window as unknown as { thinkingFixture?: { name: string; settings: ModelThinkingSettings } }).thinkingFixture;
    function Fixture() {
      const [value, setValue] = useState<ThinkingEffort>(fixture?.settings.value ?? 'xhigh');
      return <IntlProvider locale="zh-CN" messages={messages}>
        <main style={{ width: 340, margin: '80px auto', padding: 20 }}>
          <h1>{fixture?.name ?? 'Qwen3.8-27B-direct-A-best15-FP4'}</h1>
          <ThinkingEffortPicker settings={{ ...(fixture?.settings ?? { options: ['off', 'low', 'medium', 'xhigh'], toggle: false }), value }} onChange={setValue} showLabel />
          <ThinkingEffortPicker settings={{ options: [], value: null, toggle: false }} onChange={() => {}} showLabel />
        </main>
      </IntlProvider>;
    }
    createRoot(document.getElementById('root')!).render(<Fixture />);
  });
