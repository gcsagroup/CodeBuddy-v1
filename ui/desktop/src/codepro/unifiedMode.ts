export function isCodeProUnifiedModeEnabled(value: unknown): boolean {
  return value !== false && value !== 'false' && value !== 0 && value !== '0';
}

const legacyCodeProEntryPaths: Readonly<Record<string, string>> = {
  '/': '/codepro',
  '/pair': '/codepro/pair',
  '/settings': '/codepro/settings',
  '/extensions': '/codepro/extensions',
  '/apps': '/codepro/apps',
  '/sessions': '/codepro/sessions',
  '/schedules': '/codepro/schedules',
  '/recipes': '/codepro/recipes',
  '/skills': '/codepro/skills',
  '/permission': '/codepro/permission',
  '/configure-providers': '/codepro/configure-providers',
};

export function resolveCodeProEntryPath(path: string, unifiedMode: boolean): string {
  if (!unifiedMode) {
    return path;
  }
  return legacyCodeProEntryPaths[path] ?? path;
}
