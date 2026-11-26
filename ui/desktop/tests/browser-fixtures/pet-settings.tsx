import React from 'react';
import { createRoot } from 'react-dom/client';
import PetSettings from '../../src/pets/PetSettings';
import '../../src/styles/main.css';
import { applyThemeTokens } from '../../src/theme/theme-tokens';
import spriteUrl from '../../src/pets/assets/red-panda/sprites.png';
applyThemeTokens('light');
Object.assign(window, { electron: { on() {}, off() {}, desktopPet: async () => ({
  preferences: { visible: true, selectedId: 'panda', size: 256, reducedMotion: false },
  pets: [{ schemaVersion: 1, id: 'panda', name: 'Panda', description: '陪伴桌面，也帮你留意任务进展。会待机眨眼、挥手打招呼、轻盈跳跃、专注工作，等人时打瞌睡，完成任务后庆祝。', image: 'sprites.png', columns: 6, rows: 8, cellWidth: 192, cellHeight: 208, fps: 6, imageUrl: spriteUrl, hash: 'fixture', builtin: true }], errors: [], task: null, creationDirectory: 'fixture/pets'
}) } });
createRoot(document.getElementById('root')!).render(<main style={{ maxWidth: 800, margin: '24px auto', padding: 16 }}><PetSettings /></main>);
