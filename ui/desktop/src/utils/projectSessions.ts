import type { SessionListItem } from '../acp/sessions';

export interface ProjectGroup {
  path: string;
  label: string;
  sessions: SessionListItem[];
  lastActivityAt: string;
}

function getSessionActivityTime(session: SessionListItem): string {
  return session.lastMessageAt ?? session.updatedAt;
}

const UNKNOWN_PROJECT_LABEL = 'Unknown';

export function normalizeProjectPath(workingDir: string): string {
  const normalized = workingDir.trim();
  if (!normalized) {
    return '';
  }

  const withoutTrailingSeparators = normalized.replace(/[\\/]+$/, '');
  return withoutTrailingSeparators || normalized;
}

export function projectPathIdentity(workingDir: string): string {
  const normalized = normalizeProjectPath(workingDir);
  const windowsPath = /^[a-zA-Z]:[\\/]/u.test(normalized) || /^(?:\\\\|\/\/)/u.test(normalized);
  if (!windowsPath) return normalized;

  const withBackslashes = normalized.replace(/\//gu, '\\');
  const uncPrefix = withBackslashes.startsWith('\\\\') ? '\\\\' : '';
  const collapsed = `${uncPrefix}${withBackslashes.slice(uncPrefix.length).replace(/\\+/gu, '\\')}`;
  const driveRoot = /^[a-zA-Z]:\\$/u.test(collapsed);
  return (driveRoot ? collapsed : collapsed.replace(/\\+$/u, '')).toLowerCase();
}

export function getProjectLabel(workingDir: string): string {
  const normalized = workingDir.trim();
  if (!normalized) {
    return UNKNOWN_PROJECT_LABEL;
  }

  const withoutTrailingSeparators = normalizeProjectPath(workingDir);
  if (!withoutTrailingSeparators) {
    return normalized;
  }

  const parts = withoutTrailingSeparators.split(/[\\/]+/);
  return parts[parts.length - 1] || normalized;
}

export function groupSessionsByProject(sessions: SessionListItem[]): ProjectGroup[] {
  const groups = new Map<string, { path: string; sessions: SessionListItem[] }>();

  for (const session of sessions) {
    if (session.globalConversation) continue;
    const path = normalizeProjectPath(session.workingDir);
    const identity = projectPathIdentity(path);
    const existing = groups.get(identity);
    if (existing) {
      existing.sessions.push(session);
    } else {
      groups.set(identity, { path, sessions: [session] });
    }
  }

  const baseGroups = Array.from(groups.values()).map(({ path, sessions: projectSessions }) => {
    const sortedSessions = [...projectSessions].sort(
      (a, b) =>
        new Date(getSessionActivityTime(b)).getTime() -
        new Date(getSessionActivityTime(a)).getTime()
    );
    return {
      path,
      label: projectSessions.find(session => session.agentProfile)?.agentProfile?.name || getProjectLabel(path),
      sessions: sortedSessions,
      lastActivityAt: getSessionActivityTime(
        sortedSessions[0] ?? ({ updatedAt: '' } as SessionListItem)
      ),
    };
  });

  const labelCounts = baseGroups.reduce((counts, group) => {
    counts.set(group.label, (counts.get(group.label) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());

  return baseGroups
    .map((group) => ({
      ...group,
      label:
        (labelCounts.get(group.label) ?? 0) > 1
          ? getDisambiguatedProjectLabel(group.path)
          : group.label,
    }))
    .sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime());
}

export function groupNavigationSessions(
  sessions: SessionListItem[],
  defaultWorkspaceRoot: string,
  pinnedIds: readonly string[] = []
): { tasks: SessionListItem[]; projects: ProjectGroup[] } {
  const root = projectPathIdentity(defaultWorkspaceRoot);
  const separator = root.includes('\\') || /^[a-z]:/u.test(root) ? '\\' : '/';
  const rootPrefix = root.endsWith(separator) ? root : root + separator;
  const tasks: SessionListItem[] = [];
  const projects: SessionListItem[] = [];
  for (const session of sessions) {
    if (session.globalConversation) continue;
    const directory = projectPathIdentity(session.workingDir);
    // New sessions retain the actual choice. Older records only know their cwd;
    // the configured managed root is their display fallback, never a permissions rule.
    const isTask =
      session.workspaceOrigin === 'selected'
        ? false
        : session.workspaceOrigin === 'default' ||
          session.workspaceBinding === 'unbound' ||
          !directory ||
          (!!root && (directory === root || directory.startsWith(rootPrefix)));
    (isTask ? tasks : projects).push(session);
  }
  tasks.sort(
    (a, b) =>
      new Date(getSessionActivityTime(b)).getTime() - new Date(getSessionActivityTime(a)).getTime()
  );
  const pinOrder = new Map(pinnedIds.map((id, index) => [id, index]));
  const sortPins = (items: SessionListItem[]) => items.sort((a, b) =>
    (pinOrder.get(a.id) ?? Infinity) - (pinOrder.get(b.id) ?? Infinity) || 0);
  return { tasks: sortPins(tasks), projects: groupSessionsByProject(projects).map(group => ({
    ...group, sessions: sortPins(group.sessions),
  })) };
}

function getDisambiguatedProjectLabel(workingDir: string): string {
  const withoutTrailingSeparators = normalizeProjectPath(workingDir);
  if (!withoutTrailingSeparators) {
    return UNKNOWN_PROJECT_LABEL;
  }
  const parts = withoutTrailingSeparators.split(/[\\/]+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }

  return getProjectLabel(workingDir);
}
