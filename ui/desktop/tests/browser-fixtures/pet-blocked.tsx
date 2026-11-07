import React from 'react';
import { createRoot } from 'react-dom/client';
import DesktopPet from '../../src/pets/DesktopPet';
import type { PetSnapshot, PetTaskState, PetRequest } from '../../src/pets/petTypes';
import spriteUrl from '../../src/pets/assets/red-panda/sprites.png';

const callbacks = new Map<string, (event: unknown, value: unknown) => void>();
const snapshot: PetSnapshot = {
  preferences: { visible: true, selectedId: 'red-panda', size: 160, reducedMotion: false },
  pets: [
    {
      schemaVersion: 1,
      id: 'red-panda',
      name: 'Panda',
      description: '',
      image: 'sprites.png',
      columns: 6,
      rows: 8,
      cellWidth: 192,
      cellHeight: 208,
      fps: 6,
      imageUrl: spriteUrl,
      hash: 'fixture',
      builtin: true,
    },
  ],
  task: { sessionId: 'fixture', title: 'Blocked conversation', state: 'blocked' },
  errors: [],
  creationDirectory: '',
};
const petRequests: PetRequest[] = [];
Object.assign(window, {
  petRequests,
  electron: {
    desktopPet: async (request: PetRequest) => { petRequests.push(request); return snapshot; },
    petSignal: () => {},
    on: (event: string, listener: (event: unknown, value: unknown) => void) =>
      callbacks.set(event, listener),
    off: (event: string) => callbacks.delete(event),
  },
});
function publish(state: PetTaskState) {
  snapshot.task = { ...snapshot.task!, state };
  callbacks.get('pet-changed')?.({}, { ...snapshot });
}
createRoot(document.getElementById('root')!).render(
  <>
    <DesktopPet />
    <nav style={{ position: 'fixed', left: 380, top: 20 }}>
      <button onClick={() => publish('blocked')}>blocked</button>
      <button onClick={() => publish('working')}>working</button>
    </nav>
  </>
);
