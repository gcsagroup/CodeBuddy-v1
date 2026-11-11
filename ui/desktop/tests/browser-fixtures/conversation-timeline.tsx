import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import zhCN from '../../src/i18n/messages/zh-CN.json';
import { ConversationTimeline } from '../../src/components/ConversationTimeline';
import ProgressiveMessageList from '../../src/components/ProgressiveMessageList';
import { ScrollArea, type ScrollAreaHandle } from '../../src/components/ui/scroll-area';
import type { Message } from '../../src/types/message';
import { applyThemeTokens } from '../../src/theme/theme-tokens';
import '../../src/styles/main.css';

applyThemeTokens('light');
Object.assign(window, {
  electron: {
    platform: 'win32',
    on: () => {},
    off: () => {},
    getSetting: async () => false,
    logInfo: () => {},
    workspacePanel: async () => ({}),
  },
});
const messages: Message[] = Array.from({ length: 80 }, (_, i) => ({
  id: `message-${i}`,
  role: i % 2 ? 'assistant' : 'user',
  created: i + 1,
  metadata: { userVisible: true, agentVisible: true },
  content: [
    {
      type: 'text',
      text:
        i % 2
          ? `Reply for turn ${(i + 1) / 2}. ` + 'Visible response content. '.repeat(15)
          : `Question ${i / 2 + 1}`,
    },
  ],
}));
function Fixture() {
  const scrollRef = useRef<ScrollAreaHandle>(null);
  const sequence = useRef(0);
  const [target, setTarget] = useState<{ messageId: string; request: number }>();
  return (
    <IntlProvider locale="en" messages={{}}>
      <div className="relative flex flex-col h-screen">
        <ScrollArea ref={scrollRef} autoScroll className="flex-1 min-h-0" paddingX={8}>
          <ProgressiveMessageList
            messages={messages}
            chat={{ sessionId: 'timeline-browser' }}
            isUserMessage={(m) => m.role === 'user'}
            navigationTarget={target}
            onNavigationReady={(element) => {
              const viewport = scrollRef.current!.viewportRef.current!;
              scrollRef.current!.scrollToPosition({
                top:
                  viewport.scrollTop +
                  element.getBoundingClientRect().top -
                  viewport.getBoundingClientRect().top -
                  12,
                behavior: 'auto',
              });
            }}
          />
        </ScrollArea>
        <ConversationTimeline
          messages={messages}
          scrollRef={scrollRef}
          onNavigate={(messageId) => {
            scrollRef.current!.scrollToPosition({
              top: scrollRef.current!.viewportRef.current!.scrollTop,
              behavior: 'auto',
            });
            setTarget({ messageId, request: ++sequence.current });
          }}
        />
      </div>
    </IntlProvider>
  );
}
function TimedTurnFixture() {
  const [start] = useState(() => Math.floor(Date.now() / 1000));
  const [end, setEnd] = useState<Message>();
  const user = { ...messages[0], created: start };
  function finish(status: 'completed' | 'cancelled') {
    const created = Math.floor(Date.now() / 1000);
    setEnd({ ...messages[1], id: 'end', created, content: [{
      type: 'systemNotification', notificationType: 'turnTerminal', msg: '',
      data: {
        schema_version: 1, session_id: 'timer', run_id: 'run', terminal_message_id: 'end',
        source_user_message_id: user.id, status, checkpoint_id: null, retry_strategy: 'not_available',
        visible_text_available: true, tool_action_count: 0, copy_artifact_ref: null,
        finished_at: new Date(created * 1000).toISOString(),
      },
    }] });
  }
  return <IntlProvider locale="zh-CN" messages={Object.fromEntries(Object.entries(zhCN).map(([key, value]) => [key, value.defaultMessage]))}>
    <button onClick={() => finish('completed')}>完成</button>
    <button onClick={() => finish('cancelled')}>停止</button>
    <ProgressiveMessageList messages={end ? [user, end] : [user]} isStreamingMessage={!end}
      chat={{ sessionId: 'timer' }} isUserMessage={m => m.role === 'user'} />
  </IntlProvider>;
}
createRoot(document.getElementById('root')!).render(
  new URLSearchParams(location.search).has('timer') ? <TimedTurnFixture /> : <Fixture />
);
