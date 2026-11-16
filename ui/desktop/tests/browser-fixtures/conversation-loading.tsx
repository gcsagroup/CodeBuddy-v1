import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import ConversationLoading from '../../src/components/ConversationLoading';
import { applyThemeTokens } from '../../src/theme/theme-tokens';
import '../../src/styles/main.css';
import '../../src/styles/startup-loader.css';

const dark = new URLSearchParams(location.search).has('dark');
document.documentElement.classList.toggle('dark', dark);
applyThemeTokens(dark ? 'dark' : 'light');
function Fixture() {
  const [loading, setLoading] = useState(true);
  return <IntlProvider locale="zh-CN" messages={{ 'loadingGoose.loadingConversation': '正在加载对话…' }}>
    <div className="flex h-screen flex-col bg-background-primary text-text-primary">
      <header className="p-4">历史对话</header>
      <main className="relative min-h-0 flex-1" data-testid="conversation-area">
        {loading ? <ConversationLoading /> : <p>历史内容已显示</p>}
      </main>
      <footer className="p-6"><button onClick={() => setLoading(value => !value)}>切换加载状态</button></footer>
    </div>
  </IntlProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
