import { describe, expect, it } from 'vitest';
import { isCodeProUnifiedModeEnabled, resolveCodeProEntryPath } from './unifiedMode';

describe('CodePro unified mode', () => {
  it('is enabled by default and keeps an explicit rollback value', () => {
    expect(isCodeProUnifiedModeEnabled(undefined)).toBe(true);
    expect(isCodeProUnifiedModeEnabled(null)).toBe(true);
    expect(isCodeProUnifiedModeEnabled(false)).toBe(false);
    expect(isCodeProUnifiedModeEnabled('false')).toBe(false);
    expect(isCodeProUnifiedModeEnabled(0)).toBe(false);
    expect(isCodeProUnifiedModeEnabled('0')).toBe(false);
    expect(isCodeProUnifiedModeEnabled(true)).toBe(true);
    expect(isCodeProUnifiedModeEnabled('true')).toBe(true);
  });

  it.each([
    ['/', '/codepro'],
    ['/pair', '/codepro/pair'],
    ['/settings', '/codepro/settings'],
    ['/extensions', '/codepro/extensions'],
    ['/apps', '/codepro/apps'],
    ['/sessions', '/codepro/sessions'],
    ['/schedules', '/codepro/schedules'],
    ['/recipes', '/codepro/recipes'],
    ['/skills', '/codepro/skills'],
    ['/permission', '/codepro/permission'],
    ['/configure-providers', '/codepro/configure-providers'],
  ])('maps the legacy %s entry to %s', (legacyPath, codeProPath) => {
    expect(resolveCodeProEntryPath(legacyPath, true)).toBe(codeProPath);
  });

  it('leaves canonical, unknown and rollback paths unchanged', () => {
    expect(resolveCodeProEntryPath('/codepro/pair', true)).toBe('/codepro/pair');
    expect(resolveCodeProEntryPath('/standalone-app', true)).toBe('/standalone-app');
    expect(resolveCodeProEntryPath('/', false)).toBe('/');
    expect(resolveCodeProEntryPath('/pair', false)).toBe('/pair');
  });
});
