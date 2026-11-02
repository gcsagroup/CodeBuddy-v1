import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { IntlProvider } from 'react-intl';
import '../../src/styles/main.css';
import { applyThemeTokens } from '../../src/theme/theme-tokens';
import type { ActionRequired } from '../../src/types/message';

const params = new URLSearchParams(location.search);
applyThemeTokens(params.has('dark') ? 'dark' : 'light');
document.documentElement.classList.toggle('dark', params.has('dark'));
Object.assign(window, { appConfig: { get: () => undefined }, electron: { logInfo: () => {} } });
const question = "请告知 CodeBuddy 主窗口的窗口标题（例如包含 'CodeBuddy' 的文本）以便定位窗口。";
const multi = params.has('multi');
const request: ActionRequired & { type: 'actionRequired' } = {
  type: 'actionRequired',
  data: {
    actionType: 'elicitation',
    id: 'test',
    nativeQuestion: true,
    message: '',
    requested_schema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string', title: question },
        ...(multi ? { detail: { type: 'string', title: '补充说明'.repeat(40) } } : {}),
      },
    },
  },
};
Promise.all([import('../../src/components/ElicitationDock'), import('../../src/i18n')]).then(
  async ([{ default: Dock }, { loadMessages }]) => {
    const messages = await loadMessages('zh-CN');
    function Fixture() {
      const [result, setResult] = useState('');
      return (
        <IntlProvider locale="zh-CN" messages={messages}>
          <main className="mx-auto max-w-[55rem] bg-background-primary p-2">
            <Dock
              requests={result ? [] : [request]}
              onSubmit={async (_id, data, action) => {
                setResult(JSON.stringify({ data, action }));
                return true;
              }}
            />
            <output>{result}</output>
          </main>
        </IntlProvider>
      );
    }
    createRoot(document.getElementById('root')!).render(<Fixture />);
  }
);
