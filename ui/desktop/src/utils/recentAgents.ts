export const RECENT_AGENTS_KEY = 'codebuddy:recent-agents';
export const RECENT_AGENTS_CHANGED = 'codebuddy:recent-agents-changed';

type RecentAgent = { id: string; usedAt: number };

function readEntries(): RecentAgent[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(RECENT_AGENTS_KEY) ?? '[]');
    if (!Array.isArray(saved)) return [];
    return saved.flatMap(entry => {
      // Old catalogs contain IDs in recency order and have no timestamps.
      if (typeof entry === 'string' && entry) return [{ id: entry, usedAt: 0 }];
      return entry && typeof entry.id === 'string' && Number.isFinite(entry.usedAt) ? [entry as RecentAgent] : [];
    });
  } catch {
    return [];
  }
}

export function getRecentAgents(): string[] {
  return [...new Set(readEntries().map(entry => entry.id))];
}

export function agentUseTime(): number {
  return window.performance.timeOrigin + window.performance.now();
}

export async function rememberRecentAgent(id: string | null | undefined, usedAt = agentUseTime()): Promise<void> {
  if (!id) return;
  const commit = () => {
    const entries = readEntries();
    if (entries.some(entry => entry.id === id && entry.usedAt > usedAt)) return;
    const recent = [{ id, usedAt }, ...entries.filter(entry => entry.id !== id)]
      .sort((a, b) => b.usedAt - a.usedAt);
    try {
      localStorage.setItem(RECENT_AGENTS_KEY, JSON.stringify(recent));
    } catch {
      // The current window can still update its menu when storage is unavailable.
    }
    window.dispatchEvent(new CustomEvent(RECENT_AGENTS_CHANGED, { detail: recent.map(entry => entry.id) }));
  };
  try {
    // A read/modify/write of localStorage is not atomic between renderers.
    if (navigator.locks) await navigator.locks.request(RECENT_AGENTS_KEY, commit);
    else commit();
  } catch {
    // A display preference must not block using an agent.
  }
}
