import React from 'react';
import { createRoot } from 'react-dom/client';
import DesktopPet from '../../src/pets/DesktopPet';
import '../../src/styles/main.css';
import { applyThemeTokens } from '../../src/theme/theme-tokens';
import spriteUrl from '../../src/pets/assets/red-panda/sprites.png';

applyThemeTokens('light');
Object.assign(window, { electron: { on() {}, off() {}, petSignal() {}, desktopPet: async () => ({
  preferences: { visible: true, selectedId: 'red-panda', size: 160, reducedMotion: true },
  pets: [{ id: 'red-panda', name: '小熊猫', columns: 6, rows: 8, cellWidth: 192, cellHeight: 208, fps: 6, imageUrl: spriteUrl }],
  task: null, tasks: [], errors: [], creationDirectory: 'fixture',
}) } });
createRoot(document.getElementById('root')!).render(<DesktopPet />);
