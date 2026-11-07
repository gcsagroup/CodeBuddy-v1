import React from 'react';
import { createRoot } from 'react-dom/client';
import { petTaskFromSnapshot } from '../../src/pets/petTaskAdapter';
import type { AcpChatSessionSnapshot } from '../../src/acp/chatSessionStore';
import { ChatState } from '../../src/types/chatState';
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
function publishTitle(named: boolean) {
  snapshot.task = petTaskFromSnapshot('fixture', {
    session: { name: named ? '天气应用' : 'New Session', user_set_name: false },
    messages: [{ id: 'u', role: 'user', content: [{ type: 'text', text: '帮我开发天气应用' }] }],
    chatState: ChatState.Streaming,
  } as unknown as AcpChatSessionSnapshot);
  callbacks.get('pet-changed')?.({}, { ...snapshot });
}
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
      <button onClick={() => publishTitle(false)}>New task</button>
      <button onClick={() => publishTitle(true)}>Named task</button>
    </nav>
  </>
);
