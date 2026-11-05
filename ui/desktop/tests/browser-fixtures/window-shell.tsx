import React from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '../../src/contexts/ThemeContext';
import { WindowMenuBar } from '../../src/components/Layout/WindowMenuBar';
import { MainPanelLayout } from '../../src/components/Layout/MainPanelLayout';
import { ChatInputCard } from '../../src/components/ChatInputCard';
import '../../src/styles/main.css';
import '../../src/styles/desktop-shell.css';

Object.assign(window, {
  electron: {
    platform: 'win32',
    getSetting: async (key: string) => (key === 'theme' ? 'light' : false),
    setSetting: async () => {},
    on: () => {},
    off: () => {},
    setTitlebarTheme: async () => {},
    getWindowMenu: async () =>
      ['文件', '编辑', '视图', '窗口', '帮助'].map((label, index) => ({
        index,
        label,
        enabled: true,
      })),
    openWindowMenu: async (index: number) => {
      document.querySelector('output')!.textContent = String(index);
    },
  },
});
createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <div className="desktop-shell flex h-screen flex-col">
      <WindowMenuBar />
      <div className="min-h-0 flex-1">
        <MainPanelLayout removeTopPadding>
          <header className="shell-chat-header">Layout acceptance</header>
          <div className="min-h-0 flex-1 overflow-auto">
            {Array.from({ length: 80 }, (_, i) => (
              <p key={i}>Message {i}</p>
            ))}
          </div>
          <ChatInputCard>
            <div className="shell-composer">
              <textarea aria-label="Message" />
            </div>
          </ChatInputCard>
          <output />
        </MainPanelLayout>
      </div>
    </div>
  </ThemeProvider>
);
