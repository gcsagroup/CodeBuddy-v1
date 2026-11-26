import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import '../../src/styles/main.css';
import { applyThemeTokens } from '../../src/theme/theme-tokens';
Object.assign(window, { appConfig: { get: () => undefined }, electron: { platform: 'win32', logInfo() {} } });
applyThemeTokens('light');
import('../../src/components/sessions/SessionSearchDialog').then(({ SessionSearchDialog }) => {
  function Fixture() {
    const [open, setOpen] = useState(false); const [selected, setSelected] = useState('');
    return <IntlProvider locale="zh-CN" messages={{}}><button onClick={() => setOpen(true)}>搜索会话</button><output>{selected}</output><SessionSearchDialog open={open} onOpenChange={setOpen} onSelect={setSelected} /></IntlProvider>;
  }
  createRoot(document.getElementById('root')!).render(<Fixture />);
});
