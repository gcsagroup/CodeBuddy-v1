import { useSyncExternalStore } from 'react';

const KEY = 'codebuddy.sessionPins.v1';
export const SESSION_PINS_CHANGED = 'codebuddy-session-pins-changed';
const EMPTY: readonly string[] = [];
let previousRaw: string | null | undefined;
let previousIds: readonly string[] = EMPTY;

export function readSessionPins(): readonly string[] {
  let raw: string | null;
  try { raw = localStorage.getItem(KEY); } catch { return EMPTY; }
  if (raw === previousRaw) return previousIds;
  previousRaw = raw;
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    previousIds = Array.isArray(value)
      ? [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))]
      : EMPTY;
  } catch { previousIds = EMPTY; }
  return previousIds;
}

export function setSessionPinned(id: string, pinned: boolean) {
  const ids = readSessionPins().filter((value) => value !== id);
  localStorage.setItem(KEY, JSON.stringify(pinned ? [id, ...ids] : ids));
  window.dispatchEvent(new Event(SESSION_PINS_CHANGED));
}

function subscribe(notify: () => void) {
  const storage = (event: StorageEvent) => { if (event.key === KEY || event.key === null) notify(); };
  window.addEventListener(SESSION_PINS_CHANGED, notify);
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener(SESSION_PINS_CHANGED, notify);
    window.removeEventListener('storage', storage);
  };
}

export function useSessionPins() {
  return useSyncExternalStore(subscribe, readSessionPins, () => EMPTY);
}
