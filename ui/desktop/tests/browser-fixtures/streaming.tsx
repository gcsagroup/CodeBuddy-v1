import { Profiler, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import MarkdownContent from '../../src/components/MarkdownContent';
import GooseMessage from '../../src/components/GooseMessage';
import type { Message } from '../../src/types/message';
import { ScrollArea, type ScrollAreaHandle } from '../../src/components/ui/scroll-area';
import { IntlTestWrapper } from '../../src/i18n/test-utils';
import '../../src/components/ui/stream-prose.css';

const proseAnswer =
  '# 流式阅读\n\n文字应该平缓出现，屏幕随着内容连续移动。\n\n' +
  '| 层 | 位置 | 职责 |\n| --- | --- | --- |\n' +
  '| 界面 | ui/desktop/src/components/MarkdownContent.tsx | 展示已经接收的正文 |\n' +
  '| 传输 | ui/desktop/src/acp/chatSessionStore.ts | 接收真实事件并更新会话 |\n\n' +
  '## 稳定的阅读位置\n\n' +
  '新文字继续增长，已经显示的内容保持稳定。读者向上滚动时，不再追赶最新位置。\n\n'.repeat(25);
const longCode = window.location.search.includes('long-code');
const answer = longCode
  ? '```html\n<!DOCTYPE html>\n<html><body><script>\n' +
    Array.from(
      { length: 140 },
      (_, i) => `const enemy${i} = { x: Math.random() * 400, y: -30, speed: 2 }; // 飞机大战\n`
    ).join('') +
    '</script></body></html>\n```\nDone.'
  : proseAnswer;
const samples: number[] = [];
Object.assign(window, { streamRenderSamples: samples });

function Body({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div data-testid="body" data-visible={text.length} data-received={text.length}>
      <MarkdownContent
        content={text}
        animateIncoming={streaming}
        className="codepro-stream-prose"
      />
    </div>
  );
}

function Fixture() {
  const area = useRef<ScrollAreaHandle>(null);
  const [started, setStarted] = useState(false);
  const [text, setText] = useState('');
  const [streaming, setStreaming] = useState(true);
  useEffect(() => {
    if (!started) return;
    let index = 0;
    // Deliberately bursty transport, including a silent interval. The current
    // renderer paints all received text without a delayed playback queue.
    const timer = setInterval(
      () => {
        index++;
        if (!longCode && (index === 3 || index === 4)) return;
        const size = longCode ? 90 : 160;
        setText(answer.slice(0, Math.min(answer.length, index * size)));
        if (index * size >= answer.length) {
          setStreaming(false);
          clearInterval(timer);
        }
      },
      longCode ? 30 : 500
    );
    return () => clearInterval(timer);
  }, [started]);
  return (
    <IntlTestWrapper>
      <main style={{ width: 850, padding: 24 }}>
        <button onClick={() => area.current?.scrollToBottom()}>Latest</button>
        <button onClick={() => setStarted(true)}>Start</button>
        <output data-testid="transport">{streaming ? 'receiving' : 'finished'}</output>
        <ScrollArea ref={area} autoScroll style={{ height: 480, border: '1px solid gray' }}>
          <div style={{ padding: 24 }}>
            <div style={{ height: 700 }}>Earlier conversation</div>
            <Profiler id="stream" onRender={(_id, _phase, duration) => samples.push(duration)}>
              <Body text={text} streaming={streaming} />
            </Profiler>
          </div>
        </ScrollArea>
      </main>
    </IntlTestWrapper>
  );
}
const footerMessage: Message = {
  id: 'footer',
  role: 'assistant',
  created: 1,
  content: [{ type: 'text', text: 'Finished answer' }],
  metadata: {
    userVisible: true,
    agentVisible: true,
    usage: { inputTokens: 1200, outputTokens: 340, totalTokens: 1540 },
  },
};
createRoot(document.getElementById('root')!).render(
  window.location.search.includes('footer') ? (
    <IntlTestWrapper>
      <div style={{ padding: 40, width: 800 }}>
        <GooseMessage
          compactTools
          sessionId="footer-session"
          message={footerMessage}
          messages={[footerMessage]}
          toolCallNotifications={new Map()}
          append={() => {}}
          isStreaming={false}
        />
      </div>
    </IntlTestWrapper>
  ) : (
    <Fixture />
  )
);
