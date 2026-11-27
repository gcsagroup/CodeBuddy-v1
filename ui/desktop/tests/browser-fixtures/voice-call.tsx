import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/styles/main.css';
import { applyThemeTokens } from '../../src/theme/theme-tokens';
import { WorkspaceVoiceCall } from '../../src/workspace-panel/WorkspaceVoiceCall';

applyThemeTokens('light');
createRoot(document.getElementById('root')!).render(
  <main style={{ height: '100vh', display: 'flex', maxWidth: 520, margin: 'auto' }}>
    <WorkspaceVoiceCall sessionId="voice-fixture" />
  </main>
);
