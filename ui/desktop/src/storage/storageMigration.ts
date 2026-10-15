import { execFile, spawnSync } from 'node:child_process';
import path from 'node:path';

export type StorageMigrationState =
  | 'not_started'
  | 'planned'
  | 'copying'
  | 'verifying'
  | 'ready_to_commit'
  | 'committed'
  | 'failed'
  | 'conflict';

export interface StorageBootInput {
  layoutReady: boolean;
  legacyData: boolean;
  migrationState: StorageMigrationState;
}

export interface AutomaticLegacyMigrationInput {
  codeBuddyHome?: string;
  qualificationUserDataDir?: string;
  explicitOptIn?: string;
}

export type StorageBootDecision =
  | { kind: 'InitializeNew' }
  | { kind: 'UseCurrent' }
  | { kind: 'MigrateThenRelaunch' }
  | {
      kind: 'StopWithActionableError';
      reason:
        | 'conflict'
        | 'insufficient_space'
        | 'migration_failed'
        | 'invalid_report'
        | 'preflight_timeout';
      report?: StorageMigrationReport;
    };

export type StorageMigrationReportStatus =
  | 'no_record'
  | 'not_required'
  | 'migration_required'
  | 'conflict'
  | 'insufficient_space'
  | 'failed'
  | 'committed';

export interface StorageMigrationConflictCandidate {
  sourceId: string;
  size: number;
  digestSha256: string;
}

export interface StorageMigrationConflictItem {
  targetPath: string;
  candidates: StorageMigrationConflictCandidate[];
}

export interface StorageMigrationReport {
  status: StorageMigrationReportStatus;
  migrationId: string;
  targetRoot: string;
  copiedFiles: number;
  copiedBytes: number;
  conflicts: number;
  conflictItems: StorageMigrationConflictItem[];
  legacyRoots: string[];
  reportPath: string | null;
}

export interface StorageMigrationCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  termination?: 'completed' | 'timed_out' | 'cancelled' | 'termination_failed';
  signal?: string | null;
  killed?: boolean;
}

type ProcessEnvironment = Record<string, string | undefined>;
type ProcessExecutionError = Error & { code?: string | number };
type StorageMigrationAbortSignal = {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
};

export interface StorageMigrationChildProcess {
  result: Promise<Required<Omit<StorageMigrationCommandResult, 'termination'>>>;
  terminateTree(): Promise<boolean>;
}

export interface StorageMigrationTreeTermination {
  platform: string;
  pid?: number;
  runTaskkill(): Promise<boolean>;
  fallbackKill(): void;
  childResult: Promise<unknown>;
  confirmationTimeoutMs: number;
}

export type StartStorageMigrationChild = (
  binaryPath: string,
  args: readonly string[],
  env: ProcessEnvironment
) => StorageMigrationChildProcess;

export interface StorageMigrationRunOptions {
  signal?: StorageMigrationAbortSignal;
  timeoutMs?: number;
}

export interface StorageMigrationCommandRunner {
  run(
    binaryPath: string,
    args: readonly string[],
    env: ProcessEnvironment,
    options?: StorageMigrationRunOptions
  ): Promise<StorageMigrationCommandResult>;
}

export interface StoragePreflightCommandRunner {
  run(
    binaryPath: string,
    args: readonly string[],
    env: ProcessEnvironment
  ): StorageMigrationCommandResult;
}

export interface RunStorageMigrationOptions {
  binaryPath: string;
  homeDir: string;
  env: ProcessEnvironment;
  signal?: StorageMigrationAbortSignal;
  timeoutMs?: number;
}

export type RunStoragePreflightOptions = Pick<
  RunStorageMigrationOptions,
  'binaryPath' | 'homeDir' | 'env'
>;

export type StorageMigrationOutcome =
  | { kind: 'Continue' }
  | { kind: 'Relaunch'; report: StorageMigrationReport }
  | {
      kind: 'Stop';
      reason:
        | 'conflict'
        | 'insufficient_space'
        | 'migration_failed'
        | 'invalid_report'
        | 'preflight_timeout'
        | 'migration_timeout'
        | 'migration_cancelled'
        | 'migration_termination_failed';
    };

export const DEFAULT_STORAGE_MIGRATION_TIMEOUT_MS = 120_000;
export const DEFAULT_STORAGE_PREFLIGHT_TIMEOUT_MS = 30_000;
export const STORAGE_MIGRATION_TERMINATION_CONFIRMATION_TIMEOUT_MS = 5_000;

export async function terminateStorageMigrationProcessTree(
  termination: StorageMigrationTreeTermination
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const requiresTaskkill = termination.platform === 'win32' && termination.pid !== undefined;
    let taskkillSettled = !requiresTaskkill;
    let taskkillSucceeded = false;
    let childSettled = false;
    let fallbackRequested = false;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(confirmed);
    };
    const requestFallback = () => {
      if (fallbackRequested) return;
      fallbackRequested = true;
      termination.fallbackKill();
    };
    const finishAfterChildExit = () => {
      if (!childSettled) return;
      if (!requiresTaskkill) {
        finish(true);
      } else if (taskkillSucceeded) {
        finish(true);
      } else if (taskkillSettled || fallbackRequested) {
        finish(false);
      }
    };
    const onConfirmationTimeout = () => {
      if (!taskkillSettled && !fallbackRequested) {
        requestFallback();
        timeout = setTimeout(onConfirmationTimeout, termination.confirmationTimeoutMs);
        return;
      }
      finish(false);
    };
    let timeout = setTimeout(onConfirmationTimeout, termination.confirmationTimeoutMs);
    void termination.childResult.then(
      () => {
        childSettled = true;
        finishAfterChildExit();
      },
      () => {
        childSettled = true;
        finishAfterChildExit();
      }
    );
    if (termination.platform === 'win32' && termination.pid !== undefined) {
      void termination.runTaskkill().then(
        (succeeded) => {
          taskkillSettled = true;
          if (succeeded) {
            taskkillSucceeded = true;
          } else {
            requestFallback();
          }
          finishAfterChildExit();
        },
        () => {
          taskkillSettled = true;
          requestFallback();
          finishAfterChildExit();
        }
      );
    } else {
      requestFallback();
    }
  });
}

export function decideStorageBoot(input: StorageBootInput): StorageBootDecision {
  if (input.layoutReady || input.migrationState === 'committed') {
    return { kind: 'UseCurrent' };
  }
  return { kind: 'InitializeNew' };
}

export function canStartStorageBackend(decision: StorageBootDecision): boolean {
  return decision.kind === 'InitializeNew' || decision.kind === 'UseCurrent';
}

export function shouldAutomaticallyMigrateLegacy(input: AutomaticLegacyMigrationInput): boolean {
  return input.explicitOptIn === '1';
}

export function parseStorageMigrationReport(output: string): StorageMigrationReport {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error('invalid storage migration report: output is not JSON');
  }
  if (!isObject(value)) {
    throw new Error('invalid storage migration report: expected an object');
  }

  const statuses = new Set<StorageMigrationReportStatus>([
    'no_record',
    'not_required',
    'migration_required',
    'conflict',
    'insufficient_space',
    'failed',
    'committed',
  ]);
  const status = value.status;
  if (
    typeof status !== 'string' ||
    !statuses.has(status as StorageMigrationReportStatus) ||
    typeof value.migrationId !== 'string' ||
    typeof value.targetRoot !== 'string' ||
    !isNonNegativeInteger(value.copiedFiles) ||
    !isNonNegativeInteger(value.copiedBytes) ||
    !isNonNegativeInteger(value.conflicts) ||
    !isConflictItems(value.conflictItems) ||
    !Array.isArray(value.legacyRoots) ||
    !value.legacyRoots.every((root) => typeof root === 'string') ||
    !(value.reportPath === null || typeof value.reportPath === 'string')
  ) {
    throw new Error('invalid storage migration report: schema mismatch');
  }
  if (
    (status === 'committed' && typeof value.reportPath !== 'string') ||
    (status === 'not_required' &&
      (value.migrationId !== '00000000-0000-0000-0000-000000000000' ||
        value.copiedFiles !== 0 ||
        value.copiedBytes !== 0 ||
        value.legacyRoots.length !== 0 ||
        value.reportPath !== null)) ||
    (status === 'no_record' && (value.reportPath !== null || value.legacyRoots.length !== 0)) ||
    (status === 'conflict' && value.conflicts < 1) ||
    (status !== 'conflict' && (value.conflicts !== 0 || value.conflictItems.length !== 0))
  ) {
    throw new Error('invalid storage migration report: inconsistent status fields');
  }

  return {
    status: status as StorageMigrationReportStatus,
    migrationId: value.migrationId,
    targetRoot: value.targetRoot,
    copiedFiles: value.copiedFiles,
    copiedBytes: value.copiedBytes,
    conflicts: value.conflicts,
    conflictItems: value.conflictItems.map((item) => ({
      targetPath: item.targetPath,
      candidates: item.candidates.map((candidate) => ({
        sourceId: candidate.sourceId,
        size: candidate.size,
        digestSha256: candidate.digestSha256,
      })),
    })),
    legacyRoots: value.legacyRoots as string[],
    reportPath: value.reportPath,
  };
}

const defaultStoragePreflightCommandRunner: StoragePreflightCommandRunner = {
  run(binaryPath, args, env) {
    const result = spawnSync(binaryPath, [...args], {
      env,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: DEFAULT_STORAGE_PREFLIGHT_TIMEOUT_MS,
      windowsHide: true,
    });
    const processError = result.error as ProcessExecutionError | undefined;
    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? processError?.message ?? '',
      termination: processError?.code === 'ETIMEDOUT' ? 'timed_out' : 'completed',
      signal: result.signal,
      killed: result.signal !== null,
    };
  },
};

export function runStoragePreflight(
  options: RunStoragePreflightOptions,
  runner: StoragePreflightCommandRunner = defaultStoragePreflightCommandRunner
): StorageBootDecision {
  const result = runner.run(options.binaryPath, ['storage', 'preflight', '--json'], {
    ...options.env,
    CODEBUDDY_HOME: options.homeDir,
    CODEBUDDY_PROFILE: 'local',
  });
  if (result.termination === 'timed_out') {
    return { kind: 'StopWithActionableError', reason: 'preflight_timeout' };
  }
  let report: StorageMigrationReport;
  try {
    report = parseStorageMigrationReport(result.stdout);
  } catch {
    return { kind: 'StopWithActionableError', reason: 'invalid_report' };
  }
  if (normalizedPathKey(report.targetRoot) !== normalizedPathKey(options.homeDir)) {
    return { kind: 'StopWithActionableError', reason: 'invalid_report' };
  }
  if (result.exitCode === 0 && report.status === 'not_required') {
    return { kind: 'InitializeNew' };
  }
  if (result.exitCode === 0 && report.status === 'committed') {
    return { kind: 'UseCurrent' };
  }
  if (result.exitCode === 2 && report.status === 'migration_required') {
    return { kind: 'MigrateThenRelaunch' };
  }
  if (result.exitCode === 2 && report.status === 'conflict') {
    return { kind: 'StopWithActionableError', reason: 'conflict', report };
  }
  if (result.exitCode === 2 && report.status === 'insufficient_space') {
    return { kind: 'StopWithActionableError', reason: 'insufficient_space', report };
  }
  return { kind: 'StopWithActionableError', reason: 'migration_failed' };
}

const startStorageMigrationChild: StartStorageMigrationChild = (binaryPath, args, env) => {
  let childProcess!: ReturnType<typeof execFile>;
  const result = new Promise<Required<Omit<StorageMigrationCommandResult, 'termination'>>>(
    (resolve) => {
      childProcess = execFile(
        binaryPath,
        [...args],
        {
          env,
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const processError = error as ProcessExecutionError | null;
          const errorCode = processError?.code;
          resolve({
            exitCode: typeof errorCode === 'number' ? errorCode : error ? 1 : 0,
            stdout,
            stderr,
            signal: childProcess.signalCode,
            killed: childProcess.killed,
          });
        }
      );
    }
  );

  return {
    result,
    terminateTree() {
      const pid = childProcess.pid;
      return terminateStorageMigrationProcessTree({
        platform: process.platform,
        pid,
        runTaskkill: () => {
          const taskkill = path.join(
            process.env.SystemRoot ?? 'C:\\Windows',
            'System32',
            'taskkill.exe'
          );
          return new Promise<boolean>((resolve) => {
            execFile(
              taskkill,
              ['/PID', String(pid), '/T', '/F'],
              { windowsHide: true },
              (error) => {
                resolve(error === null);
              }
            );
          });
        },
        fallbackKill: () => {
          childProcess.kill();
        },
        childResult: result,
        confirmationTimeoutMs: STORAGE_MIGRATION_TERMINATION_CONFIRMATION_TIMEOUT_MS,
      });
    },
  };
};

export function createStorageMigrationCommandRunner(
  startChild: StartStorageMigrationChild = startStorageMigrationChild
): StorageMigrationCommandRunner {
  return {
    run(binaryPath, args, env, options = {}) {
      const child = startChild(binaryPath, args, env);
      const timeoutMs = options.timeoutMs ?? DEFAULT_STORAGE_MIGRATION_TIMEOUT_MS;
      return new Promise((resolve) => {
        let settled = false;
        let terminating = false;
        const finish = (result: StorageMigrationCommandResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          options.signal?.removeEventListener('abort', cancel);
          resolve(result);
        };
        const terminate = (termination: 'timed_out' | 'cancelled') => {
          if (settled || terminating) return;
          terminating = true;
          const finishTermination = (terminated: boolean) =>
            finish({
              exitCode: 1,
              stdout: '',
              stderr: terminated ? '' : 'storage migration process tree termination failed',
              termination: terminated ? termination : 'termination_failed',
              signal: null,
              killed: terminated,
            });
          void child.terminateTree().then(finishTermination, () => finishTermination(false));
        };
        const cancel = () => terminate('cancelled');
        const timeout = setTimeout(() => terminate('timed_out'), timeoutMs);
        options.signal?.addEventListener('abort', cancel, { once: true });
        if (options.signal?.aborted) cancel();
        void child.result.then((result) => {
          if (!terminating) finish({ ...result, termination: 'completed' });
        });
      });
    },
  };
}

export const defaultStorageMigrationCommandRunner = createStorageMigrationCommandRunner();

export async function runStorageMigration(
  decision: StorageBootDecision,
  options: RunStorageMigrationOptions,
  runner: StorageMigrationCommandRunner = defaultStorageMigrationCommandRunner
): Promise<StorageMigrationOutcome> {
  if (decision.kind === 'InitializeNew' || decision.kind === 'UseCurrent') {
    return { kind: 'Continue' };
  }
  if (decision.kind === 'StopWithActionableError') {
    return { kind: 'Stop', reason: decision.reason };
  }

  const result = await runner.run(
    options.binaryPath,
    ['storage', 'migrate', '--json'],
    {
      ...options.env,
      CODEBUDDY_HOME: options.homeDir,
      CODEBUDDY_PROFILE: 'local',
    },
    options
  );
  if (result.termination === 'timed_out') {
    return { kind: 'Stop', reason: 'migration_timeout' };
  }
  if (result.termination === 'cancelled') {
    return { kind: 'Stop', reason: 'migration_cancelled' };
  }
  if (result.termination === 'termination_failed') {
    return { kind: 'Stop', reason: 'migration_termination_failed' };
  }
  let report: StorageMigrationReport;
  try {
    report = parseStorageMigrationReport(result.stdout);
  } catch {
    return { kind: 'Stop', reason: 'invalid_report' };
  }

  if (
    result.exitCode === 0 &&
    report.status === 'committed' &&
    normalizedPathKey(report.targetRoot) === normalizedPathKey(options.homeDir)
  ) {
    return { kind: 'Relaunch', report };
  }
  if (report.status === 'conflict') {
    return { kind: 'Stop', reason: 'conflict' };
  }
  if (report.status === 'insufficient_space') {
    return { kind: 'Stop', reason: 'insufficient_space' };
  }
  return { kind: 'Stop', reason: 'migration_failed' };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isConflictItems(value: unknown): value is StorageMigrationConflictItem[] {
  return (
    Array.isArray(value) &&
    value.length <= 100 &&
    value.every(
      (item) =>
        isObject(item) &&
        isSafeLogicalTargetPath(item.targetPath) &&
        Array.isArray(item.candidates) &&
        item.candidates.length > 0 &&
        item.candidates.length <= 16 &&
        item.candidates.every(
          (candidate) =>
            isObject(candidate) &&
            typeof candidate.sourceId === 'string' &&
            /^[A-Za-z0-9_-]+$/.test(candidate.sourceId) &&
            isNonNegativeInteger(candidate.size) &&
            typeof candidate.digestSha256 === 'string' &&
            /^[0-9a-f]{64}$/.test(candidate.digestSha256)
        )
    )
  );
}

function isSafeLogicalTargetPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.includes(':') &&
    value
      .split(/[\\/]/)
      .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}

function normalizedPathKey(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
