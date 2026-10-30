export interface DesktopOwnership {
  paused: boolean;
  revision: string | null;
  generation?: string;
  pauseReason?: string;
  owner: { sessionId: string; title: string; token: string } | null;
  queue: { sessionId: string; title: string; token: string }[];
}
const empty: DesktopOwnership = { paused: false, revision: null, owner: null, queue: [] };
let current = empty;
const listeners = new Set<() => void>();
export const getDesktopOwnership = () => current;
export const subscribeDesktopOwnership = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function updateDesktopOwnership(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<DesktopOwnership> & { event?: string };
  if (v.event && v.event !== 'desktop_control_ownership') return false;
  const validOwner = (owner: unknown) =>
    owner &&
    typeof owner === 'object' &&
    ['sessionId', 'title', 'token'].every(
      (k) => typeof (owner as Record<string, unknown>)[k] === 'string'
    );
  if (
    typeof v.paused !== 'boolean' ||
    !(v.revision === null || typeof v.revision === 'string') ||
    !(v.owner === null || validOwner(v.owner)) ||
    !Array.isArray(v.queue) ||
    !v.queue.every(validOwner)
  )
    return false;
  current = {
    paused: v.paused,
    revision: v.revision,
    ...(typeof v.generation === 'string' ? { generation: v.generation } : {}),
    ...(typeof v.pauseReason === 'string' ? { pauseReason: v.pauseReason } : {}),
    owner: v.owner,
    queue: v.queue,
  } as DesktopOwnership;
  listeners.forEach((listener) => listener());
  return true;
}
