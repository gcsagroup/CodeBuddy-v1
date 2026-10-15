export type ToolboxSection = 'all' | 'capabilities' | 'methods' | 'apps' | 'external';

const LEGACY_SECTIONS: Record<string, ToolboxSection> = {
  skills: 'methods',
  apps: 'apps',
  extensions: 'external',
};

export function getLegacyToolboxRedirect(pathname: string, search = ''): string {
  const isCodePro = pathname === '/codepro' || pathname.startsWith('/codepro/');
  const segments = pathname
    .replace(/^\/codepro\/?/, '/')
    .split('/')
    .filter(Boolean);
  const legacyRoute = segments[segments.length - 1];
  const section = (legacyRoute && LEGACY_SECTIONS[legacyRoute]) || 'capabilities';
  const params = new URLSearchParams(search);
  if (!params.has('section')) params.set('section', section);
  const query = params.toString();
  return `${isCodePro ? '/codepro' : ''}/toolbox${query ? `?${query}` : ''}`;
}
