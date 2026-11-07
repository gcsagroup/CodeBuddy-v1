const legacyCodeProEntryPaths: Readonly<Record<string, string>> = {
  '/': '/codepro',
  '/pair': '/codepro/pair',
  '/settings': '/codepro/settings',
  '/extensions': '/codepro/extensions',
  '/apps': '/codepro/apps',
  '/sessions': '/codepro/sessions',
  '/custom-agents': '/codepro/custom-agents',
  '/media-library': '/codepro/media-library',
  '/toolbox': '/codepro/toolbox',
  '/schedules': '/codepro/schedules',
  '/recipes': '/codepro/recipes',
  '/skills': '/codepro/skills',
  '/permission': '/codepro/permission',
  '/configure-providers': '/codepro/configure-providers',
};

export function resolveCodeProEntryPath(path: string): string {
  return legacyCodeProEntryPaths[path] ?? path;
}
