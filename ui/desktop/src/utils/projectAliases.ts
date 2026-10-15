import { projectPathIdentity } from './projectSessions';

export const PROJECT_ALIAS_STORAGE_KEY = 'codepro.projectAliases.v1';
export const PROJECT_ALIAS_MAX_LENGTH = 80;

interface ProjectAliasStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function readAliases(storage: ProjectAliasStorage): Record<string, string> {
  try {
    const value = storage.getItem(PROJECT_ALIAS_STORAGE_KEY);
    if (!value) return {};

    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([key, alias]) => key.length > 0 && typeof alias === 'string' && alias.trim().length > 0
      )
    );
  } catch {
    return {};
  }
}

export function getProjectAlias(
  projectPath: string,
  fallbackLabel: string,
  storage: ProjectAliasStorage | undefined = typeof window === 'undefined'
    ? undefined
    : window.localStorage
): string {
  if (!storage) return fallbackLabel;
  return readAliases(storage)[projectPathIdentity(projectPath)] ?? fallbackLabel;
}

export function saveProjectAlias(
  projectPath: string,
  alias: string,
  fallbackLabel: string,
  storage: ProjectAliasStorage | undefined = typeof window === 'undefined'
    ? undefined
    : window.localStorage
): string {
  const normalizedAlias = alias.trim().slice(0, PROJECT_ALIAS_MAX_LENGTH);
  const resolvedLabel = normalizedAlias || fallbackLabel;
  if (!storage) return resolvedLabel;

  const aliases = readAliases(storage);
  const identity = projectPathIdentity(projectPath);
  if (!normalizedAlias || normalizedAlias === fallbackLabel) {
    delete aliases[identity];
  } else {
    aliases[identity] = normalizedAlias;
  }
  storage.setItem(PROJECT_ALIAS_STORAGE_KEY, JSON.stringify(aliases));
  return resolvedLabel;
}
