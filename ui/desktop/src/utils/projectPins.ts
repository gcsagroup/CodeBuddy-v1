import { useSyncExternalStore } from 'react';
import { projectPathIdentity } from './projectSessions';
const KEY = 'codebuddy.projectPins.v1';
const EVENT = 'codebuddy-project-pins-changed';
const EMPTY: readonly string[] = [];
let rawCache: string | null | undefined;
let cache: readonly string[] = EMPTY;
export function readProjectPins(): readonly string[] {
  let raw: string | null;
  try { raw = localStorage.getItem(KEY); } catch { return EMPTY; }
  if (raw === rawCache) return cache;
  rawCache = raw;
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    cache = Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string').map(projectPathIdentity))] : EMPTY;
  } catch { cache = EMPTY; }
  return cache;
}
export function setProjectPinned(path: string, pinned: boolean) {
  const id = projectPathIdentity(path);
  const rest = readProjectPins().filter(value => value !== id);
  localStorage.setItem(KEY, JSON.stringify(pinned ? [id, ...rest] : rest));
  window.dispatchEvent(new Event(EVENT));
}
function subscribe(notify: () => void) {
  const storage = (event: StorageEvent) => { if (event.key === KEY || event.key === null) notify(); };
  window.addEventListener(EVENT, notify);
  window.addEventListener('storage', storage);
  return () => { window.removeEventListener(EVENT, notify); window.removeEventListener('storage', storage); };
}
export const useProjectPins = () => useSyncExternalStore(subscribe, readProjectPins, () => EMPTY);
