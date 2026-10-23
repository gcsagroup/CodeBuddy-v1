import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { useWorkStatus } from '../../src/components/codepro/useWorkStatus';
import LoadingGoose from '../../src/components/LoadingGoose';
import '../../src/styles/main.css';
import { ChatState } from '../../src/types/chatState';
import { loadMessages } from '../../src/i18n';

const locale = new URLSearchParams(window.location.search).get('locale') || 'zh-CN';
const modes = [
  'waiting',
  'thought',
  'text',
  'tool_result',
  'approval',
  'cancel',
  'reconnect',
] as const;

function Fixture() {
  const [mode, setMode] = useState<(typeof modes)[number]>('waiting');
  const [receivedAt, setReceivedAt] = useState(Date.now());
  const status = useWorkStatus({
    chatState: mode === 'approval' ? ChatState.WaitingForUserInput : ChatState.Streaming,
    checking: false,
    cancelling: mode === 'cancel',
    action: mode === 'approval' ? '发送消息' : undefined,
    activity: {
      promptAttemptId: 'browser-fixture',
      sourceUserMessageId: 'fixture',
      startedAt: receivedAt,
      receivedAt,
      kind: mode === 'thought' || mode === 'text' ? mode : undefined,
      execution:
        mode === 'tool_result'
          ? { phase: 'tool_result', childCount: 0 }
          : mode === 'waiting' || mode === 'reconnect'
            ? {
                phase: 'model',
                childCount: 0,
                modelRequestPhase: 'waiting',
                detail: mode === 'reconnect' ? '连接发生错误；正在重新连接（1/5）' : undefined,
              }
            : undefined,
    },
  });
  return (
    <main style={{ fontFamily: 'system-ui', padding: 40 }}>
      <h1>CodeBuddy · 进度文案验收</h1>
      <div style={{ maxWidth: 720, padding: 20, background: '#f6f7f9', borderRadius: 12 }}>
        <LoadingGoose
          chatState={ChatState.Streaming}
          message={status.message}
          announcement={status.announcement}
          hint={status.hint}
        />
      </div>
      <nav>
        {modes.map((value) => (
          <button
            key={value}
            onClick={() => {
              setReceivedAt(Date.now());
              setMode(value);
            }}
          >
            {value}
          </button>
        ))}
      </nav>
    </main>
  );
}

void loadMessages(locale).then((messages) => {
  createRoot(document.getElementById('root')!).render(
    <IntlProvider locale={locale} messages={messages}>
      <Fixture />
    </IntlProvider>
  );
});
