import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
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
createRoot(document.getElementById('root')!).render(<Fixture />);
