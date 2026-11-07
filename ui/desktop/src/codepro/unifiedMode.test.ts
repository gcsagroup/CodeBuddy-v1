import { describe, expect, it } from 'vitest';
import { resolveCodeProEntryPath } from './unifiedMode';

describe('CodePro unified mode', () => {
  it.each([
    ['/', '/codepro'],
    ['/pair', '/codepro/pair'],
    ['/settings', '/codepro/settings'],
    ['/extensions', '/codepro/extensions'],
    ['/apps', '/codepro/apps'],
    ['/sessions', '/codepro/sessions'],
    ['/toolbox', '/codepro/toolbox'],
    ['/custom-agents', '/codepro/custom-agents'],
    ['/media-library', '/codepro/media-library'],
    ['/schedules', '/codepro/schedules'],
    ['/recipes', '/codepro/recipes'],
    ['/skills', '/codepro/skills'],
    ['/permission', '/codepro/permission'],
    ['/configure-providers', '/codepro/configure-providers'],
  ])('maps the legacy %s entry to %s', (legacyPath, codeProPath) => {
    expect(resolveCodeProEntryPath(legacyPath)).toBe(codeProPath);
  });

  it('leaves canonical and unknown paths unchanged', () => {
    expect(resolveCodeProEntryPath('/codepro/pair')).toBe('/codepro/pair');
    expect(resolveCodeProEntryPath('/standalone-app')).toBe('/standalone-app');
  });
});
