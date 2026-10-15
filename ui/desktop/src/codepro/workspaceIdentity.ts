import * as posix from '@jsr/std__path/posix';

export function normalizeWorkspaceIdentity(value: string): string {
  if (/^(?:[a-zA-Z]:[\\/]|\\\\)/u.test(value)) {
    return normalizeWindowsWorkspaceIdentity(value);
  }
  const normalized = posix.normalize(value);
  return normalized.length > 1 ? normalized.replace(/\/+$/u, '') : normalized;
}

export function normalizeWindowsWorkspaceIdentity(value: string): string {
  const normalized = value.replace(/\//gu, '\\');
  const withoutDevicePrefix = normalized.startsWith('\\\\?\\') ? normalized.slice(4) : normalized;
  return withoutDevicePrefix.replace(/\\+$/u, '').toLowerCase();
}
