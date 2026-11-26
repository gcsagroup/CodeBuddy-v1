import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import '../../src/styles/main.css';
import '../../src/styles/desktop-shell.css';
import '../../src/workspace-panel/workspacePanel.css';
import { applyThemeTokens } from '../../src/theme/theme-tokens';
Object.assign(window, { appConfig: { get: () => undefined }, electron: { platform: 'win32', logInfo() {} } });
applyThemeTokens('light');
Promise.all([import('../../src/components/ModelInventoryNotice'), import('../../src/components/ThinkingEffortPicker'), import('../../src/components/settings/providers/subcomponents/ProviderCard'), import('../../src/i18n'), import('../../src/acp/providers')]).then(async ([{ ModelInventoryNotice }, { ModelThinkingMenu }, { ProviderCard }, { loadMessages }, { acpListProviderDetails }]) => {
  const messages = await loadMessages('zh-CN');
  function Fixture() {
    const [mode, setMode] = useState('loading');
    const [enabled, setEnabled] = useState(true);
    const [supported, setSupported] = useState(false);
    const [selecting, setSelecting] = useState(false);
    const [showSettings, setShowSettings] = useState(true);
    const [panelOpen, setPanelOpen] = useState(false);
    const [callCount, setCallCount] = useState(0);
    const reload = async () => { const [provider] = await acpListProviderDetails(); setEnabled(provider.enabled !== false); };
    return <IntlProvider locale="zh-CN" messages={messages}><main style={{ padding: '100px 24px', maxWidth: 950, margin: 'auto' }}>
      <div className="desktop-shell workspace-panel" data-platform="win32" style={{ position: 'absolute', top: 36, left: 0, right: 0 }}>
        <header className="shell-chat-header flex h-12 shrink-0 items-center gap-3 px-6 pr-16">
          <h1 className="min-w-0 flex-1 truncate">主对话</h1>
          {!panelOpen && <button aria-label="打电话" className="rounded-lg p-2" onClick={() => setCallCount(callCount + 1)}>☎</button>}
        </header>
        {panelOpen ? <div className="wb-header-actions" style={{ position: 'absolute', right: 12, top: 9 }}>
          <button className="wb-icon" aria-label="新建面板">+</button>
          <button className="wb-icon" aria-label="最大化面板">□</button>
          <button className="wb-icon" aria-label="关闭面板" onClick={() => setPanelOpen(false)}>×</button>
        </div> : <button className="wb-icon" aria-label="打开面板" style={{ position: 'absolute', right: 12, top: 12 }} onClick={() => setPanelOpen(true)}>▣</button>}
      </div>
      <output data-testid="call-count">{callCount}</output>
      <h1 className="mb-8 text-xl">模型连接设置 · 验收夹具</h1>
      <button onClick={() => setMode('error')}>模拟连接失败</button>
      <ModelInventoryNotice notices={enabled ? [{ providerId: 'p', providerName: '验收连接', changes: [], loading: mode === 'loading', failed: mode === 'error' }] : []} refresh={async () => setMode('loading')} />
      <button onClick={async () => { await reload(); setShowSettings(!showSettings); }}>{showSettings ? '关闭设置' : '打开设置'}</button>
      {showSettings && <div className="my-8 max-w-xs"><ProviderCard provider={{ name: 'p', enabled, provider_type: 'Custom', is_configured: enabled, metadata: { name: 'p', display_name: '验收连接', description: '本地测试端点', default_model: 'fixture', config_keys: [], known_models: [], model_doc_link: '' } }} onConfigure={() => {}} onLaunch={() => {}} isOnboarding={false} onEnabledChanged={() => void reload()} /></div>}
      <button onClick={() => setSupported(!supported)}>切换已确认能力</button>
      <div className="mt-40 rounded-xl border p-4" data-testid="composer"><p className="mb-8 text-sm text-text-secondary">发送消息，/ 查看功能</p><ModelThinkingMenu key={String(supported)} provider="p" model="fixture" modelLabel="测试模型" triggerContent={<span>测试模型</span>} presentation="slider" onSelectModel={() => setSelecting(true)} initialSettings={{ contextWindow: 32768, contextSource: 'service', thinking: supported ? { options: ['low', 'high'], value: 'high', toggle: false, state: 'supported' } : { options: [], value: 'max', toggle: false, state: 'unknown' } }} /></div>
      {selecting && <p>模型选择已打开</p>}
    </main></IntlProvider>;
  }
  createRoot(document.getElementById('root')!).render(<Fixture />);
});
