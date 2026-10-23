import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import zhCN from '../../src/i18n/messages/zh-CN.json';
import type { Message } from '../../src/types/message';
import '../../src/styles/main.css';
import { applyThemeTokens } from '../../src/theme/theme-tokens';
applyThemeTokens('light');
document.documentElement.classList.add('light');
const root = location.search.includes('mac') ? '/Users/test/project' : 'D:/fixture';
Object.assign(window, {
  appConfig: { get: () => undefined },
  electron: {
    platform: root.startsWith('/') ? 'darwin' : 'win32',
    logInfo: () => {},
    on: () => () => {},
    workspacePanel: async ({ path }: { path: string }) => ({
      file: { path, size: 12335, openExternally: false },
    }),
  },
});
const paths = [
  'pelican_bike.html',
  'src/animation.ts',
  'src/styles/theme.css',
  'src/components/controls.tsx',
];
const messages: Message[] = [
  {
    id: 'turn',
    role: 'user',
    created: 1,
    content: [{ type: 'text', text: 'Create a page' }],
    metadata: { userVisible: true, agentVisible: true },
  },
  {
    id: 'result',
    role: 'assistant',
    created: 2,
    content: [{ type: 'text', text: '`pelican_bike.html` and `README.md`' }],
    metadata: { userVisible: true, agentVisible: true },
  },
];
const changes = [
  {
    id: 'turn',
    number: 1,
    created: 1,
    title: 'Create a page',
    added: 286,
    removed: 2,
    files: paths.map((path, index) => ({
      key: path,
      path: `${root}/${path}`,
      added: index === 0 ? 278 : 2,
      removed: index === 1 ? 2 : 0,
      hasUnavailableDiff: false,
      changes: [
        { path: `${root}/${path}`, added: 2, removed: 0, diff: '+line', diff_truncated: false },
      ],
    })),
  },
];
import('../../src/components/codepro/CodeProConversationFiles').then(
  ({ CodeProConversationFiles }) => {
    function Fixture() {
      const [event, setEvent] = useState('');
      React.useEffect(() => {
        const listener = (event: Event) => setEvent(JSON.stringify((event as CustomEvent).detail));
        window.addEventListener('codebuddy:open-conversation-change', listener);
        window.addEventListener('codebuddy:open-workspace-file', listener);
        return () => {
          window.removeEventListener('codebuddy:open-conversation-change', listener);
          window.removeEventListener('codebuddy:open-workspace-file', listener);
        };
      }, []);
      return (
        <main
          style={{
            maxWidth: 860,
            margin: '64px auto',
            padding: 16,
            fontFamily: 'Segoe UI, Microsoft YaHei, system-ui, sans-serif',
            fontSize: 14,
          }}
        >
          <p>已创建网页动画，可在右侧查看文件和本轮变更。</p>
          <CodeProConversationFiles
            sessionId="fixture"
            workspaceRoot={root}
            messages={messages}
            sourceChanges={changes}
          />
          <output>{event}</output>
        </main>
      );
    }
    createRoot(document.getElementById('root')!).render(
      <IntlProvider
        locale="zh-CN"
        messages={Object.fromEntries(
          Object.entries(zhCN).map(([key, value]) => [key, value.defaultMessage])
        )}
      >
        <Fixture />
      </IntlProvider>
    );
  }
);
