import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_STORAGE_MIGRATION_TIMEOUT_MS,
  terminateStorageMigrationProcessTree,
  createStorageMigrationCommandRunner,
  canStartStorageBackend,
  decideStorageBoot,
  parseStorageMigrationReport,
  runStoragePreflight,
  runStorageMigration,
  shouldAutomaticallyMigrateLegacy,
  type StorageMigrationChildProcess,
  type StorageMigrationCommandRunner,
  type StoragePreflightCommandRunner,
} from './storageMigration';

describe('storage migration process limits', () => {
  it('does not confirm tree termination when taskkill fails and only the child exits', async () => {
    let completeChild!: () => void;
    const childResult = new Promise<void>((resolve) => {
      completeChild = resolve;
    });
    const fallbackKill = vi.fn();
    let settled = false;

    const termination = terminateStorageMigrationProcessTree({
      platform: 'win32',
      pid: 42,
      runTaskkill: vi.fn().mockResolvedValue(false),
      fallbackKill,
      childResult,
      confirmationTimeoutMs: 10_000,
    }).then((value) => {
      settled = true;
      return value;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(fallbackKill).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    completeChild();
    await expect(termination).resolves.toBe(false);
  });

  it('does not confirm tree termination when taskkill hangs and only the child exits', async () => {
    vi.useFakeTimers();
    let completeChild!: () => void;
    const childResult = new Promise<void>((resolve) => {
      completeChild = resolve;
    });
    const fallbackKill = vi.fn();
    let settled = false;
    const termination = terminateStorageMigrationProcessTree({
      platform: 'win32',
      pid: 42,
      runTaskkill: () => new Promise<boolean>(() => undefined),
      fallbackKill,
      childResult,
      confirmationTimeoutMs: 10,
    }).then((value) => {
      settled = true;
      return value;
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(fallbackKill).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    completeChild();
    await expect(termination).resolves.toBe(false);
    vi.useRealTimers();
  });

  it('confirms Windows tree termination only after taskkill succeeds and the child exits', async () => {
    let completeChild!: () => void;
    const childResult = new Promise<void>((resolve) => {
      completeChild = resolve;
    });
    const fallbackKill = vi.fn();
    const termination = terminateStorageMigrationProcessTree({
      platform: 'win32',
      pid: 42,
      runTaskkill: vi.fn().mockResolvedValue(true),
      fallbackKill,
      childResult,
      confirmationTimeoutMs: 10_000,
    });

    await Promise.resolve();
    completeChild();

    await expect(termination).resolves.toBe(true);
    expect(fallbackKill).not.toHaveBeenCalled();
  });

  it('terminates the process tree once at the bounded timeout and ignores a late callback', async () => {
    vi.useFakeTimers();
    let complete!: (result: {
      exitCode: number;
      stdout: string;
      stderr: string;
      signal: string | null;
      killed: boolean;
    }) => void;
    const child: StorageMigrationChildProcess = {
      result: new Promise((resolve) => {
        complete = resolve;
      }),
      terminateTree: vi.fn().mockResolvedValue(true),
    };
    const runner = createStorageMigrationCommandRunner(() => child);
    const result = runner.run('goose.exe', ['storage', 'migrate', '--json'], {}, {});

    await vi.advanceTimersByTimeAsync(DEFAULT_STORAGE_MIGRATION_TIMEOUT_MS - 1);
    expect(child.terminateTree).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ termination: 'timed_out', killed: true });
    expect(child.terminateTree).toHaveBeenCalledTimes(1);

    complete({ exitCode: 0, stdout: '{}', stderr: '', signal: null, killed: false });
    await Promise.resolve();
    expect(child.terminateTree).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('cancels the process tree without waiting for the timeout', async () => {
    vi.useFakeTimers();
    const child: StorageMigrationChildProcess = {
      result: new Promise(() => undefined),
      terminateTree: vi.fn().mockResolvedValue(true),
    };
    const runner = createStorageMigrationCommandRunner(() => child);
    const controller = new AbortController();
    const result = runner.run(
      'goose.exe',
      ['storage', 'migrate', '--json'],
      {},
      {
        signal: controller.signal,
      }
    );

    controller.abort();
    await expect(result).resolves.toMatchObject({ termination: 'cancelled', killed: true });
    expect(child.terminateTree).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it.each([
    ['timed_out', false],
    ['cancelled', true],
  ] as const)(
    'gives %s priority over child completion while tree termination is in flight',
    async (termination, cancel) => {
      vi.useFakeTimers();
      let completeChild!: (result: {
        exitCode: number;
        stdout: string;
        stderr: string;
        signal: string | null;
        killed: boolean;
      }) => void;
      let completeTermination!: (terminated: boolean) => void;
      const child: StorageMigrationChildProcess = {
        result: new Promise((resolve) => {
          completeChild = resolve;
        }),
        terminateTree: vi.fn(
          () =>
            new Promise<boolean>((resolve) => {
              completeTermination = resolve;
            })
        ),
      };
      const runner = createStorageMigrationCommandRunner(() => child);
      const controller = new AbortController();
      let settled = false;
      const result = runner
        .run(
          'goose.exe',
          ['storage', 'migrate', '--json'],
          {},
          {
            signal: controller.signal,
            timeoutMs: 1,
          }
        )
        .then((value) => {
          settled = true;
          return value;
        });

      if (cancel) controller.abort();
      else await vi.advanceTimersByTimeAsync(1);
      completeChild({ exitCode: 0, stdout: '{}', stderr: '', signal: null, killed: false });
      await Promise.resolve();
      expect(settled).toBe(false);

      completeTermination(true);
      await expect(result).resolves.toMatchObject({ termination });
      expect(child.terminateTree).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    }
  );

  it('reports termination_failed instead of killed when exit cannot be confirmed', async () => {
    vi.useFakeTimers();
    const child: StorageMigrationChildProcess = {
      result: new Promise(() => undefined),
      terminateTree: vi.fn().mockResolvedValue(false),
    };
    const runner = createStorageMigrationCommandRunner(() => child);
    const result = runner.run('goose.exe', ['storage', 'migrate', '--json'], {}, { timeoutMs: 1 });

    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({
      termination: 'termination_failed',
      killed: false,
    });
    vi.useRealTimers();
  });
});

describe('storage boot decision', () => {
  it('initializes the unified layout by default even when legacy data exists', () => {
    expect(
      decideStorageBoot({ layoutReady: false, legacyData: true, migrationState: 'not_started' })
    ).toEqual({ kind: 'InitializeNew' });
  });

  it('initializes the unified layout when no legacy data exists', () => {
    expect(
      decideStorageBoot({ layoutReady: false, legacyData: false, migrationState: 'not_started' })
    ).toEqual({ kind: 'InitializeNew' });
  });

  it('uses the unified layout after a committed migration', () => {
    expect(
      decideStorageBoot({ layoutReady: true, legacyData: true, migrationState: 'committed' })
    ).toEqual({ kind: 'UseCurrent' });
  });

  it('does not let a legacy conflict block default startup or invoke migration', async () => {
    const decision = decideStorageBoot({
      layoutReady: false,
      legacyData: true,
      migrationState: 'conflict',
    });
    const runner: StorageMigrationCommandRunner = { run: vi.fn() };

    expect(decision).toEqual({ kind: 'InitializeNew' });
    expect(canStartStorageBackend(decision)).toBe(true);
    await expect(
      runStorageMigration(
        decision,
        { binaryPath: 'C:\\app\\goose.exe', homeDir: 'C:\\Users\\test\\.CodeBuddy', env: {} },
        runner
      )
    ).resolves.toEqual({ kind: 'Continue' });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('runs legacy discovery only after explicit opt-in', () => {
    expect(shouldAutomaticallyMigrateLegacy({})).toBe(false);
    expect(
      shouldAutomaticallyMigrateLegacy({
        codeBuddyHome: 'D:\\isolated\\.CodeBuddy',
      })
    ).toBe(false);
    expect(
      shouldAutomaticallyMigrateLegacy({
        codeBuddyHome: 'D:\\isolated\\.CodeBuddy',
        explicitOptIn: '1',
      })
    ).toBe(true);
  });
});

describe('storage migration command', () => {
  it('initializes without migration only after a typed live preflight says not_required', () => {
    const runner: StoragePreflightCommandRunner = {
      run: vi.fn().mockReturnValue({
        exitCode: 0,
        stdout: JSON.stringify({
          status: 'not_required',
          migrationId: '00000000-0000-0000-0000-000000000000',
          targetRoot: 'C:\\Users\\test\\.CodeBuddy',
          copiedFiles: 0,
          copiedBytes: 0,
          conflicts: 0,
          conflictItems: [],
          legacyRoots: [],
          reportPath: null,
        }),
        stderr: '',
      }),
    };

    expect(
      runStoragePreflight(
        { binaryPath: 'C:\\app\\goose.exe', homeDir: 'C:\\Users\\test\\.CodeBuddy', env: {} },
        runner
      )
    ).toEqual({ kind: 'InitializeNew' });
    expect(runner.run).toHaveBeenCalledWith(
      'C:\\app\\goose.exe',
      ['storage', 'preflight', '--json'],
      expect.objectContaining({
        CODEBUDDY_HOME: 'C:\\Users\\test\\.CodeBuddy',
        CODEBUDDY_PROFILE: 'local',
      })
    );
  });

  it('runs migration only when the live preflight says migration_required', () => {
    const runner: StoragePreflightCommandRunner = {
      run: vi.fn().mockReturnValue({
        exitCode: 2,
        stdout: JSON.stringify({
          status: 'migration_required',
          migrationId: '019fea8a-b57b-72c2-9837-5165b5463d1f',
          targetRoot: 'C:\\Users\\test\\.CodeBuddy',
          copiedFiles: 0,
          copiedBytes: 0,
          conflicts: 0,
          conflictItems: [],
          legacyRoots: ['C:\\legacy'],
          reportPath: null,
        }),
        stderr: '',
      }),
    };

    expect(
      runStoragePreflight(
        { binaryPath: 'C:\\app\\goose.exe', homeDir: 'C:\\Users\\test\\.CodeBuddy', env: {} },
        runner
      )
    ).toEqual({ kind: 'MigrateThenRelaunch' });
  });

  it('fails closed with redacted conflict details and never reports migration_required', () => {
    const runner: StoragePreflightCommandRunner = {
      run: vi.fn().mockReturnValue({
        exitCode: 2,
        stdout: JSON.stringify({
          status: 'conflict',
          migrationId: '019fea8a-b57b-72c2-9837-5165b5463d1f',
          targetRoot: 'C:\\Users\\test\\.CodeBuddy',
          copiedFiles: 0,
          copiedBytes: 0,
          conflicts: 1,
          conflictItems: [
            {
              targetPath: 'profiles/local/config/config.yaml',
              candidates: [
                { sourceId: 'legacy', size: 10, digestSha256: 'a'.repeat(64) },
                { sourceId: 'unified-target', size: 12, digestSha256: 'b'.repeat(64) },
              ],
            },
          ],
          legacyRoots: ['C:\\legacy'],
          reportPath: null,
        }),
        stderr: '',
      }),
    };

    const decision = runStoragePreflight(
      { binaryPath: 'C:\\app\\goose.exe', homeDir: 'C:\\Users\\test\\.CodeBuddy', env: {} },
      runner
    );

    expect(decision).toMatchObject({
      kind: 'StopWithActionableError',
      reason: 'conflict',
      report: { conflictItems: [{ targetPath: 'profiles/local/config/config.yaml' }] },
    });
    expect(canStartStorageBackend(decision)).toBe(false);
  });

  it.each([
    [{ exitCode: 0, stdout: '{broken', stderr: '' }, 'invalid_report'],
    [
      { exitCode: 1, stdout: '', stderr: 'timed out', termination: 'timed_out' },
      'preflight_timeout',
    ],
  ] as const)('fails closed for an unusable live preflight result', (result, reason) => {
    const runner: StoragePreflightCommandRunner = { run: vi.fn().mockReturnValue(result) };

    expect(
      runStoragePreflight(
        { binaryPath: 'C:\\app\\goose.exe', homeDir: 'C:\\Users\\test\\.CodeBuddy', env: {} },
        runner
      )
    ).toEqual({ kind: 'StopWithActionableError', reason });
  });

  it.each([
    ['timed_out', 'migration_timeout'],
    ['cancelled', 'migration_cancelled'],
    ['termination_failed', 'migration_termination_failed'],
  ] as const)(
    'classifies a %s process without parsing an empty report',
    async (termination, reason) => {
      const runner: StorageMigrationCommandRunner = {
        run: vi.fn().mockResolvedValue({
          exitCode: 1,
          stdout: '',
          stderr: '',
          termination,
          signal: null,
          killed: true,
        }),
      };

      await expect(
        runStorageMigration(
          { kind: 'MigrateThenRelaunch' },
          {
            binaryPath: 'C:\\app\\goose.exe',
            homeDir: 'C:\\Users\\test\\.CodeBuddy',
            env: {},
          },
          runner
        )
      ).resolves.toEqual({ kind: 'Stop', reason });
    }
  );

  it('accepts only the bounded report contract', () => {
    expect(
      parseStorageMigrationReport(
        JSON.stringify({
          status: 'committed',
          migrationId: '019fea8a-b57b-72c2-9837-5165b5463d1f',
          targetRoot: 'C:\\Users\\test\\.CodeBuddy',
          copiedFiles: 3,
          copiedBytes: 69,
          conflicts: 0,
          conflictItems: [],
          legacyRoots: ['C:\\legacy'],
          reportPath: 'C:\\Users\\test\\.CodeBuddy\\migrations\\manifest.jsonl',
        })
      ).status
    ).toBe('committed');
    expect(() => parseStorageMigrationReport('{"status":"committed"}')).toThrow(
      'invalid storage migration report'
    );
    expect(
      parseStorageMigrationReport(
        JSON.stringify({
          status: 'not_required',
          migrationId: '00000000-0000-0000-0000-000000000000',
          targetRoot: 'C:\\Users\\test\\.CodeBuddy',
          copiedFiles: 0,
          copiedBytes: 0,
          conflicts: 0,
          conflictItems: [],
          legacyRoots: [],
          reportPath: null,
        })
      )
    ).toMatchObject({ status: 'not_required', reportPath: null });
    expect(() =>
      parseStorageMigrationReport(
        JSON.stringify({
          status: 'not_required',
          migrationId: '00000000-0000-0000-0000-000000000000',
          targetRoot: 'C:\\Users\\test\\.CodeBuddy',
          copiedFiles: 0,
          copiedBytes: 0,
          conflicts: 0,
          conflictItems: [],
          legacyRoots: [],
          reportPath: 'C:\\unexpected\\manifest.jsonl',
        })
      )
    ).toThrow('invalid storage migration report');
    expect(() =>
      parseStorageMigrationReport(
        JSON.stringify({
          status: 'not_required',
          migrationId: '019fea8a-b57b-72c2-9837-5165b5463d1f',
          targetRoot: 'C:\\Users\\test\\.CodeBuddy',
          copiedFiles: 1,
          copiedBytes: 10,
          conflicts: 0,
          conflictItems: [],
          legacyRoots: ['C:\\legacy'],
          reportPath: null,
        })
      )
    ).toThrow('invalid storage migration report');
    expect(() =>
      parseStorageMigrationReport(
        JSON.stringify({
          status: 'conflict',
          migrationId: '019fea8a-b57b-72c2-9837-5165b5463d1f',
          targetRoot: 'C:\\Users\\test\\.CodeBuddy',
          copiedFiles: 0,
          copiedBytes: 0,
          conflicts: 1,
          conflictItems: [
            {
              targetPath: '../secrets.txt',
              candidates: [{ sourceId: '../legacy', size: 1, digestSha256: 'a'.repeat(64) }],
            },
          ],
          legacyRoots: [],
          reportPath: null,
        })
      )
    ).toThrow('invalid storage migration report');
    expect(() =>
      parseStorageMigrationReport(
        JSON.stringify({
          status: 'not_required',
          migrationId: '00000000-0000-0000-0000-000000000000',
          targetRoot: 'C:\\Users\\test\\.CodeBuddy',
          copiedFiles: 0,
          copiedBytes: 0,
          conflicts: 1,
          conflictItems: [],
          legacyRoots: [],
          reportPath: null,
        })
      )
    ).toThrow('invalid storage migration report');
    expect(
      parseStorageMigrationReport(
        JSON.stringify({
          status: 'conflict',
          migrationId: '019fea8a-b57b-72c2-9837-5165b5463d1f',
          targetRoot: 'C:\\Users\\test\\.CodeBuddy',
          copiedFiles: 0,
          copiedBytes: 0,
          conflicts: 1,
          conflictItems: [],
          legacyRoots: [],
          reportPath: null,
        })
      )
    ).toMatchObject({ status: 'conflict', conflictItems: [] });
  });

  it('returns only the conflict report allowlist', () => {
    const report = parseStorageMigrationReport(
      JSON.stringify({
        status: 'conflict',
        migrationId: '019fea8a-b57b-72c2-9837-5165b5463d1f',
        targetRoot: 'C:\\Users\\test\\.CodeBuddy',
        copiedFiles: 0,
        copiedBytes: 0,
        conflicts: 1,
        conflictItems: [
          {
            targetPath: 'profiles/local/config/config.yaml',
            absoluteSourcePath: 'C:\\legacy\\secret.txt',
            content: 'secret body',
            candidates: [
              {
                sourceId: 'legacy',
                size: 10,
                digestSha256: 'a'.repeat(64),
                token: 'secret token',
              },
            ],
          },
        ],
        legacyRoots: [],
        reportPath: null,
      })
    );

    expect(report.conflictItems).toEqual([
      {
        targetPath: 'profiles/local/config/config.yaml',
        candidates: [{ sourceId: 'legacy', size: 10, digestSha256: 'a'.repeat(64) }],
      },
    ]);
    expect(JSON.stringify(report.conflictItems)).not.toContain('secret');
  });

  it('requests a relaunch only after a committed report', async () => {
    const runner: StorageMigrationCommandRunner = {
      run: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: JSON.stringify({
          status: 'committed',
          migrationId: '019fea8a-b57b-72c2-9837-5165b5463d1f',
          targetRoot: 'C:\\Users\\test\\.CodeBuddy',
          copiedFiles: 3,
          copiedBytes: 69,
          conflicts: 0,
          conflictItems: [],
          legacyRoots: ['C:\\legacy'],
          reportPath: 'C:\\Users\\test\\.CodeBuddy\\migrations\\manifest.jsonl',
        }),
        stderr: '',
      }),
    };

    await expect(
      runStorageMigration(
        { kind: 'MigrateThenRelaunch' },
        {
          binaryPath: 'C:\\app\\goose.exe',
          homeDir: 'C:\\Users\\test\\.CodeBuddy',
          env: {},
        },
        runner
      )
    ).resolves.toMatchObject({ kind: 'Relaunch', report: { status: 'committed' } });
  });

  it('stops on a conflict and does not claim a relaunch', async () => {
    const runner: StorageMigrationCommandRunner = {
      run: vi.fn().mockResolvedValue({
        exitCode: 2,
        stdout: JSON.stringify({
          status: 'conflict',
          migrationId: '019fea8a-b57b-72c2-9837-5165b5463d1f',
          targetRoot: 'C:\\Users\\test\\.CodeBuddy',
          copiedFiles: 0,
          copiedBytes: 0,
          conflicts: 1,
          conflictItems: [
            {
              targetPath: 'profiles/local/config/config.yaml',
              candidates: [
                { sourceId: 'legacy', size: 10, digestSha256: 'a'.repeat(64) },
                { sourceId: 'unified-target', size: 12, digestSha256: 'b'.repeat(64) },
              ],
            },
          ],
          legacyRoots: ['C:\\legacy'],
          reportPath: null,
        }),
        stderr: '',
      }),
    };

    await expect(
      runStorageMigration(
        { kind: 'MigrateThenRelaunch' },
        {
          binaryPath: 'C:\\app\\goose.exe',
          homeDir: 'C:\\Users\\test\\.CodeBuddy',
          env: {},
        },
        runner
      )
    ).resolves.toEqual({ kind: 'Stop', reason: 'conflict' });
  });

  it('rejects a committed report for a different target root', async () => {
    const runner: StorageMigrationCommandRunner = {
      run: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: JSON.stringify({
          status: 'committed',
          migrationId: '019fea8a-b57b-72c2-9837-5165b5463d1f',
          targetRoot: 'C:\\unexpected\\.CodeBuddy',
          copiedFiles: 1,
          copiedBytes: 10,
          conflicts: 0,
          conflictItems: [],
          legacyRoots: ['C:\\legacy'],
          reportPath: 'C:\\unexpected\\.CodeBuddy\\migrations\\manifest.jsonl',
        }),
        stderr: '',
      }),
    };

    await expect(
      runStorageMigration(
        { kind: 'MigrateThenRelaunch' },
        {
          binaryPath: 'C:\\app\\goose.exe',
          homeDir: 'C:\\Users\\test\\.CodeBuddy',
          env: {},
        },
        runner
      )
    ).resolves.toEqual({ kind: 'Stop', reason: 'migration_failed' });
  });
});
