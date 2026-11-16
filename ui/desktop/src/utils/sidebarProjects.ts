import { useSyncExternalStore } from 'react';
import { getProjectLabel, projectPathIdentity, type ProjectGroup } from './projectSessions';
const KEY = 'codebuddy.sidebarProjects.v1';
const EVENT = 'codebuddy-sidebar-projects-changed';
type Entry = { path: string; removed?: boolean };
const EMPTY: readonly Entry[] = [];
let rawCache: string | null | undefined;
let cache: readonly Entry[] = EMPTY;
export function readSidebarProjects(): readonly Entry[] {
  let raw: string | null;
  try { raw = localStorage.getItem(KEY); } catch { return EMPTY; }
  if (raw === rawCache) return cache;
  rawCache = raw;
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    cache = Array.isArray(value) ? value.filter((v): v is Entry => v && typeof v.path === 'string' && v.path.trim().length > 0).map(v => ({ path: v.path, removed: v.removed === true })) : EMPTY;
  } catch { cache = EMPTY; }
  return cache;
}
function save(entries: readonly Entry[]) {
  const raw = JSON.stringify(entries);
  if (localStorage.getItem(KEY) === raw) return;
  localStorage.setItem(KEY, raw);
  window.dispatchEvent(new Event(EVENT));
}
export function rememberSidebarProjects(paths: string[]) {
  const entries = [...readSidebarProjects()];
  for (const path of paths) if (!entries.some(e => projectPathIdentity(e.path) === projectPathIdentity(path))) entries.push({ path });
  save(entries);
}
export function setSidebarProjectVisible(path: string, visible: boolean) {
  const entries = readSidebarProjects().filter(e => projectPathIdentity(e.path) !== projectPathIdentity(path));
  save([...entries, { path, removed: !visible }]);
}
export function retainSidebarProjects(groups: ProjectGroup[], entries: readonly Entry[]) {
  const projects = groups.filter(group => !entries.some(e => e.removed && projectPathIdentity(e.path) === projectPathIdentity(group.path)));
  for (const entry of entries) if (!entry.removed && !projects.some(g => projectPathIdentity(g.path) === projectPathIdentity(entry.path))) projects.push({ path: entry.path, label: getProjectLabel(entry.path), sessions: [], lastActivityAt: '' });
  const hiddenSessions = groups.filter(g => !projects.includes(g)).flatMap(g => g.sessions);
  return { projects, hiddenSessions };
}
function subscribe(notify: () => void) {
  const storage = (event: StorageEvent) => { if (event.key === KEY || event.key === null) notify(); };
  window.addEventListener(EVENT, notify); window.addEventListener('storage', storage);
  return () => { window.removeEventListener(EVENT, notify); window.removeEventListener('storage', storage); };
}
export const useSidebarProjects = () => useSyncExternalStore(subscribe, readSidebarProjects, () => EMPTY);
