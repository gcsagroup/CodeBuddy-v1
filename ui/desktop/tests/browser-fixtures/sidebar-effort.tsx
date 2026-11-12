import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { IntlProvider } from 'react-intl';
import '../../src/styles/main.css';
import '../../src/styles/desktop-shell.css';
import { CodeProRouteGuard } from '../../src/codepro/CodeProRouteGuard';
import { getWorkspaceModeFromPath } from '../../src/utils/navigationUtils';
import { applyThemeTokens } from '../../src/theme/theme-tokens';
Object.assign(window, { appConfig: { get: (key: string) => key === 'CODEPRO_UNIFIED_MODE' ? false : undefined },
  electron: { platform: 'win32', on: () => {}, off: () => {}, logInfo: () => {}, getConfig: () => ({ GOOSE_DISABLE_NOSTR_SHARING: true }),
    directoryChooser: async () => ({ canceled: false, filePaths: ['D:/Chosen'] }),
    openDirectoryInExplorer: async (path: string) => { await (window as any).fixtureRequest('open-folder', { path }); return true; } } });
const dark = new URLSearchParams(location.search).has('dark');
document.documentElement.classList.toggle('dark', dark);
applyThemeTokens(dark ? 'dark' : 'light');
const [{ Navigation }, { NavigationProvider }, { ModelThinkingMenu }, providers, { loadMessages }] = await Promise.all([
  import('../../src/components/Layout/NavigationPanel'), import('../../src/components/Layout/NavigationContext'),
  import('../../src/components/ThinkingEffortPicker'), import('../../src/acp/providers'), import('../../src/i18n'),
]);
const messages = await loadMessages('zh-CN');
function Route() { const location = useLocation(); return <output data-testid="route">{JSON.stringify({ path: location.pathname, state: location.state })}</output>; }
function Fixture() { const location = useLocation(); return <div className="desktop-shell bg-background-primary" style={{ display: 'flex', height: 700 }}>
  <div style={{ width: 260 }}><Navigation workspaceMode={getWorkspaceModeFromPath(location.pathname)} /></div>
  <div style={{ padding: 50 }}><Route /><div style={{ marginTop: 200 }}>
    <ModelThinkingMenu provider="fixture" model="model" deferUntilSubmit presentation="slider"
      initialSettings={{ thinking: { options: ['low', 'medium', 'high'], value: 'high', toggle: false }, contextWindow: 64000, contextSource: 'catalog' }} />
    <button onClick={() => void providers.applyThinkingDraft('fixture', 'model')}>发送测试任务</button>
  </div></div>
</div>; }
createRoot(document.getElementById('root')!).render(<IntlProvider locale="zh-CN" messages={messages}><MemoryRouter initialEntries={[new URLSearchParams(window.location.search).get('entry') || '/']}><CodeProRouteGuard><NavigationProvider><Fixture /></NavigationProvider></CodeProRouteGuard></MemoryRouter></IntlProvider>);
