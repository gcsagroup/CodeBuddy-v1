import { describe, expect, it } from 'vitest';

import { applyLegacyEnvironment, resolveCodeBuddyPaths } from './codeBuddyPaths';

const windowsInput = {
  platform: 'win32' as const,
  userHome: String.raw`C:\Users\tester`,
};

describe('resolveCodeBuddyPaths', () => {
  it('reuses an existing legacy profile without copying or modifying it', () => {
    const paths = resolveCodeBuddyPaths({
      platform: 'posix',
      userHome: '/home/tester',
      directoryExists: (path) => path === '/home/tester/.CodeAgentPro',
    });
    expect(paths.homeDir).toBe('/home/tester/.CodeAgentPro');
    expect(paths.sessionsDir).toBe('/home/tester/.CodeAgentPro/profiles/local/sessions');
  });

  it('prefers an existing new profile and respects explicit overrides', () => {
    const input = {
      platform: 'posix' as const,
      userHome: '/home/tester',
      directoryExists: () => true,
    };
    expect(resolveCodeBuddyPaths(input).homeDir).toBe('/home/tester/.CodeBuddy');
    expect(resolveCodeBuddyPaths({ ...input, codeBuddyHome: '/isolated' }).homeDir).toBe(
      '/isolated'
    );
  });

  it('accepts old launch overrides while preserving explicit new values and empty-value validation', () => {
    const env = {
      CODEAGENTPRO_HOME: '/legacy',
      CODEBUDDY_HOME: '/new',
      CODEAGENTPRO_BINARY: '/old/bin',
    };
    applyLegacyEnvironment(env);
    expect(env.CODEBUDDY_HOME).toBe('/new');
    expect((env as Record<string, string>).CODEBUDDY_BINARY).toBe('/old/bin');
    const legacyOnly: Record<string, string> = { CODEAGENTPRO_HOME: '' };
    applyLegacyEnvironment(legacyOnly);
    expect(() =>
      resolveCodeBuddyPaths({
        platform: 'posix',
        userHome: '/home/tester',
        codeBuddyHome: legacyOnly.CODEBUDDY_HOME,
      })
    ).toThrow(/empty/);
  });
  it('resolves the default local profile tree', () => {
    const paths = resolveCodeBuddyPaths(windowsInput);

    expect(paths.homeDir).toBe(String.raw`C:\Users\tester\.CodeBuddy`);
    expect(paths.workspacesDir).toBe(String.raw`C:\Users\tester\.CodeBuddy\workspaces`);
    expect(paths.profileConfigDir).toBe(
      String.raw`C:\Users\tester\.CodeBuddy\profiles\local\config`
    );
    expect(paths.sessionsDir).toBe(String.raw`C:\Users\tester\.CodeBuddy\profiles\local\sessions`);
    expect(paths.modelsDir).toBe(String.raw`C:\Users\tester\.CodeBuddy\profiles\local\models`);
    expect(paths.agentsDir).toBe(String.raw`C:\Users\tester\.CodeBuddy\profiles\local\agents`);
    expect(paths.skillsDir).toBe(String.raw`C:\Users\tester\.CodeBuddy\profiles\local\skills`);
    expect(paths.electronUserDataDir).toBe(
      String.raw`C:\Users\tester\.CodeBuddy\state\electron-app`
    );
    expect(paths.electronSessionDataDir).toBe(
      String.raw`C:\Users\tester\.CodeBuddy\profiles\local\state\electron`
    );
    expect(paths.legacyOverrideSource).toBeUndefined();
  });

  it('prefers CODEBUDDY_HOME and reports a distinct legacy source', () => {
    const paths = resolveCodeBuddyPaths({
      ...windowsInput,
      codeBuddyHome: String.raw`D:\new-root`,
      goosePathRoot: String.raw`D:\legacy-root`,
    });

    expect(paths.homeDir).toBe(String.raw`D:\new-root`);
    expect(paths.workspacesDir).toBe(String.raw`D:\new-root\workspaces`);
    expect(paths.legacyOverrideSource).toBe(String.raw`D:\legacy-root`);
  });

  it('uses GOOSE_PATH_ROOT as the target when the new override is absent', () => {
    const paths = resolveCodeBuddyPaths({
      ...windowsInput,
      goosePathRoot: String.raw`D:\portable-root`,
    });

    expect(paths.homeDir).toBe(String.raw`D:\portable-root`);
    expect(paths.legacyOverrideSource).toBeUndefined();
  });

  it('rejects empty, relative, and root-escaping overrides', () => {
    expect(() => resolveCodeBuddyPaths({ ...windowsInput, codeBuddyHome: '' })).toThrow(
      /CODEBUDDY_HOME/
    );
    expect(() =>
      resolveCodeBuddyPaths({ ...windowsInput, codeBuddyHome: 'relative/root' })
    ).toThrow(/absolute/);
    expect(() =>
      resolveCodeBuddyPaths({ ...windowsInput, codeBuddyHome: String.raw`C:\..` })
    ).toThrow(/escapes/);
  });

  it('supports the same layout on POSIX systems', () => {
    const paths = resolveCodeBuddyPaths({
      platform: 'posix',
      userHome: '/home/tester',
    });

    expect(paths.homeDir).toBe('/home/tester/.CodeBuddy');
    expect(paths.runsDir).toBe('/home/tester/.CodeBuddy/profiles/local/runs');
  });

  it('rejects a POSIX override that escapes the filesystem root', () => {
    expect(() =>
      resolveCodeBuddyPaths({
        platform: 'posix',
        userHome: '/home/tester',
        codeBuddyHome: '/folder/../..',
      })
    ).toThrow(/escapes/);
  });
});
