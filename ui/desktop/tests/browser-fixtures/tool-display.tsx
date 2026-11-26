import React from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import '../../src/styles/main.css';
Object.assign(window, {
  appConfig: { get: () => undefined },
  electron: {
    platform: 'win32',
    logInfo() {},
    getSetting: async () => localStorage.getItem('fixture-tool-display') || 'concise',
    setSetting: async (_key: string, value: string) => {
      localStorage.setItem('fixture-tool-display', value);
    },
  },
});
Promise.all([
  import('../../src/components/ToolCallWithResponse'),
  import('../../src/components/ToolCallExpandable'),
  import('../../src/components/settings/response_styles/ResponseStylesSection'),
  import('../../src/i18n'),
]).then(
  async ([
    { default: Tool },
    { ToolCallExpandable },
    { ResponseStylesSection },
    { loadMessages },
  ]) => {
    const messages = await loadMessages('zh-CN');
    createRoot(document.getElementById('root')!).render(
      <IntlProvider locale="zh-CN" messages={messages}>
        <main style={{ padding: 40, maxWidth: 900, margin: 'auto' }}>
          <h1>工具过程显示验收</h1>
          <ResponseStylesSection />
          <section style={{ marginTop: 30 }}>
            <ToolCallExpandable
              compact
              respectToolDisplayStyle
              label="本轮执行过程"
              storageKey="fixture-turn"
              collapseOnSettle
              resetOnSettle
            >
              <ToolCallExpandable
                compact
                respectToolDisplayStyle
                label="执行命令"
                storageKey="fixture-group"
              >
                <Tool
                  compact
                  isCancelledMessage={false}
                  isPendingApproval={false}
                  toolRequest={{
                    type: 'toolRequest',
                    id: 'fixture-command',
                    toolCall: {
                      status: 'success',
                      value: {
                        name: 'developer__shell',
                        arguments: { command: 'printf tool-display-ok' },
                      },
                    },
                  }}
                  toolResponse={{
                    type: 'toolResponse',
                    id: 'fixture-command',
                    toolResult: {
                      status: 'success',
                      value: { content: [{ type: 'text', text: 'tool-display-ok' }] },
                    },
                  }}
                />
              </ToolCallExpandable>
            </ToolCallExpandable>
          </section>
        </main>
      </IntlProvider>
    );
  }
);
