import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { IntlProvider } from 'react-intl';
import { applyThemeTokens } from '../../src/theme/theme-tokens';
import { fixtureModel, fixtureProvider } from './composer-model-context';
import '../../src/styles/main.css';

const dark = new URLSearchParams(location.search).has('dark');
document.documentElement.classList.toggle('dark', dark);
applyThemeTokens(dark ? 'dark' : 'light');
Object.assign(window, {
  appConfig: { get: () => undefined },
  electron: {
    platform: 'win32', logInfo: () => {},
    openPastedText: async (text: string) => { Object.assign(window, { openedPastedText: text }); return { opened: true }; },
    listRecentDirs: async () => [],
    listGitWorktreeDirs: async () => [],
    directoryChooser: async () => ({ canceled: true, filePaths: [] }),
  },
});
Promise.all([
  import('../../src/components/ChatInput'),
  import('../../src/components/SessionPermissionSummary'),
  import('../../src/i18n'),
  import('../../src/types/chatState'),
  import('../../src/components/bottom_menu/DirSwitcher'),
  import('../../src/components/UserMessage'),
  import('../../src/types/message'),
]).then(async ([{ default: ChatInput }, { PermissionPicker }, { loadMessages }, { ChatState }, { DirSwitcher }, { default: UserMessage }, { createUserMessage }]) => {
  const messages = await loadMessages('zh-CN');
  function Fixture() {
    const [left, setLeft] = useState(240);
    const [right, setRight] = useState(340);
    const [tokens, setTokens] = useState(64000);
    const [busy, setBusy] = useState(false);
    const [submitted, setSubmitted] = useState('');
    const [withAttachments, setWithAttachments] = useState(false);
    const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
    return (
      <IntlProvider locale="zh-CN" messages={messages}>
        <MemoryRouter>
          <div className="flex min-h-screen flex-col bg-background-primary text-text-primary">
            <header className="flex flex-wrap gap-3 p-2 text-xs">
              <label>
                左侧宽度
                <input
                  aria-label="左侧宽度"
                  type="number"
                  value={left}
                  onChange={(e) => setLeft(Number(e.target.value))}
                />
              </label>
              <label>
                右侧宽度
                <input
                  aria-label="右侧宽度"
                  type="number"
                  value={right}
                  onChange={(e) => setRight(Number(e.target.value))}
                />
              </label>
              <label>
                用量
                <input
                  aria-label="用量"
                  type="number"
                  value={tokens}
                  onChange={(e) => setTokens(Number(e.target.value))}
                />
              </label>
              <button onClick={() => setBusy(!busy)}>切换运行状态</button>
              <button onClick={() => setWithAttachments(!withAttachments)}>混合附件</button>
            </header>
            <div className="flex min-h-0 flex-1">
              <aside style={{ width: left }} className="shrink-0 bg-background-secondary" />
              <main className="flex min-w-0 flex-1 flex-col justify-end p-3">
                <p role="status">{submitted.length < 4000 ? submitted : ''}</p>
                {submitted.length >= 4000 && <div data-testid="submitted-message"><UserMessage message={createUserMessage(submitted)} /></div>}
                <DirSwitcher className="self-start" sessionId={undefined} workingDir="" />
                <div data-testid="composer-container">
                  <ChatInput
                    sessionId="composer-layout"
                    sessionLoaded
                    sessionStats={new URLSearchParams(location.search).has('stats') ? { decodeTokens: 440, decodeMs: 2000 } : undefined}
                    liveSpeed={busy ? { rate: 42, estimated: false } : null}
                    messages={new URLSearchParams(location.search).has('stats') ? [{
                      id: 'stats-reply', role: 'assistant', created: 1, content: [],
                      metadata: { agentVisible: true, userVisible: true,
                        usage: { inputTokens: 180, cacheReadTokens: 820, totalTokens: 1040, outputTokens: 40 } },
                    }] : []}
                    droppedFiles={withAttachments ? [
                      { id: 'layout-image', path: 'C:/isolated-composer-fixture/image.png', name: 'image.png', type: 'image/png', isImage: true, isVideo: false, dataUrl: pixel },
                      { id: 'layout-video', path: 'C:/isolated-composer-fixture/video.mp4', name: 'video.mp4', type: 'video/mp4', isImage: false, isVideo: true },
                      { id: 'layout-document', path: 'C:/isolated-composer-fixture/report.txt', name: 'report.txt', type: 'text/plain', isImage: false, isVideo: false },
                    ] : []}
                    onFilesProcessed={() => setWithAttachments(false)}
                    chatState={busy ? ChatState.Thinking : ChatState.Idle}
                    sessionModel={fixtureModel}
                    sessionProvider={fixtureProvider}
                    workingDir="C:/isolated-composer-fixture"
                    totalTokens={tokens}
                    contextLimit={1000000}
                    contextUsageSource="provider_actual"
                    contextCapacitySource="service"
                    hideWorkingDirSwitcher
                    setView={() => {}}
                    onStop={() => setBusy(false)}
                handleSubmit={(input, lifecycle) => {
                  setSubmitted(input.msg);
                  Object.assign(window, { composerSubmitted: input.msg });
                  lifecycle?.onAccepted();
                    }}
                    modelToolbarSlot={
                      <PermissionPicker
                        mode="workspace-write"
                        inline
                        draft
                        onModeChange={() => {}}
                      />
                    }
                  />
                </div>
              </main>
              <aside style={{ width: right }} className="shrink-0 bg-background-secondary" />
            </div>
          </div>
        </MemoryRouter>
      </IntlProvider>
    );
  }
  createRoot(document.getElementById('root')!).render(<Fixture />);
});
