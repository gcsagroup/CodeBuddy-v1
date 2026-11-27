import React from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import '../../src/styles/main.css';
import { applyThemeTokens } from '../../src/theme/theme-tokens';
import MessageCopyLink from '../../src/components/MessageCopyLink';
import { ModelInventoryNotice } from '../../src/components/ModelInventoryNotice';
import { SpeechSettings } from '../../src/components/settings/models/SpeechSettings';
applyThemeTokens('light');
createRoot(document.getElementById('root')!).render(
  <IntlProvider locale="zh-CN" messages={{ 'messageCopyLink.copy': '复制' }}>
    <ModelInventoryNotice notices={[]} refresh={async () => {}} />
    <main style={{ maxWidth: 900, margin: 'auto', padding: 32 }}>
      <article
        data-testid="first"
        className="group mb-8 rounded-xl border border-border-primary p-6"
      >
        <p className="mb-4">
          早上好！🌞
          新的一天开始了，有什么我可以帮你的吗？我可以帮助你检查项目代码、解释问题和整理说明。你可以随时切换到另一条回复，继续收听新的内容。
        </p>
        <MessageCopyLink
          text="早上好！🌞 新的一天开始了，有什么我可以帮你的吗？我可以帮助你检查项目代码、解释问题和整理说明。你可以随时切换到另一条回复，继续收听新的内容。"
          speakable
          alwaysVisible
        />
      </article>
      <article
        data-testid="second"
        className="group mb-8 rounded-xl border border-border-primary p-6"
      >
        <p className="mb-4">当然可以。我会把这条回复分段读给你听，你也可以随时停止播放。</p>
        <MessageCopyLink
          text="当然可以。我会把这条回复分段读给你听，你也可以随时停止播放。"
          speakable
          alwaysVisible
        />
      </article>
      <SpeechSettings />
    </main>
  </IntlProvider>
);
