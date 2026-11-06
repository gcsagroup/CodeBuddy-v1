export const RECENT_AGENTS_KEY = 'codebuddy:recent-agents';
export const RECENT_AGENTS_CHANGED = 'codebuddy:recent-agents-changed';

export function getRecentAgents(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(RECENT_AGENTS_KEY) ?? '[]');
    return Array.isArray(saved)
      ? [...new Set(saved.filter((id): id is string => typeof id === 'string' && Boolean(id)))]
      : [];
  } catch {
    return [];
  }
}

export function rememberRecentAgent(id: string | null | undefined): void {
  if (!id) return;
  const recent = [id, ...getRecentAgents().filter((previous) => previous !== id)];
  try {
    localStorage.setItem(RECENT_AGENTS_KEY, JSON.stringify(recent));
  } catch {
    // A display preference must not block using an agent.
  }
  window.dispatchEvent(new CustomEvent(RECENT_AGENTS_CHANGED, { detail: recent }));
}
