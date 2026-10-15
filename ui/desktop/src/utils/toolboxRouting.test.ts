import { describe, expect, it } from 'vitest';
import { getLegacyToolboxRedirect } from './toolboxRouting';

describe('getLegacyToolboxRedirect', () => {
  it.each([
    ['/skills', '', '/toolbox?section=methods'],
    ['/apps', '?query=github', '/toolbox?query=github&section=apps'],
    ['/extensions', '?workspace=code', '/toolbox?workspace=code&section=external'],
    ['/codepro/skills', '?status=enabled', '/codepro/toolbox?status=enabled&section=methods'],
    ['/codepro/apps', '', '/codepro/toolbox?section=apps'],
    ['/codepro/extensions', '?error=offline', '/codepro/toolbox?error=offline&section=external'],
  ])('maps %s%s to %s without dropping source state', (pathname, search, expected) => {
    expect(getLegacyToolboxRedirect(pathname, search)).toBe(expected);
  });

  it('does not override an explicit section in an existing query', () => {
    expect(getLegacyToolboxRedirect('/skills', '?section=all&query=git')).toBe(
      '/toolbox?section=all&query=git'
    );
  });
});
