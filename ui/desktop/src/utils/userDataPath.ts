import path from 'node:path';

export function resolveCodeBuddyUserDataDir(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  if (!path.isAbsolute(candidate)) {
    throw new Error('CODEBUDDY_USER_DATA_DIR must be an absolute path');
  }
  return path.normalize(candidate);
}
