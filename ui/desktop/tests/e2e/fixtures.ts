import { chromium, expect, test as base, type Browser, type Page } from '@playwright/test';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { startDeterministicOpenAiServer } from './deterministic-openai-server';

const execFileAsync = promisify(execFile);
const MAX_ELECTRON_OUTPUT_CHARS = 100_000;

async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Unable to allocate a loopback port for Electron CDP');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function boundedOutput(current: string, chunk: Buffer): string {
  return `${current}${chunk.toString('utf8')}`.slice(-MAX_ELECTRON_OUTPUT_CHARS);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function sensitivePathPattern(value: string): RegExp | undefined {
  const components = value.split(/[\\/]+/u).filter(Boolean);
  if (components.length === 0) return undefined;
  return new RegExp(components.map(escapeRegExp).join(String.raw`[\\/]+`), 'giu');
}

export function sanitizeQualificationEvidence(value: string, sensitivePaths: string[]): string {
  let sanitized = value
    .replace(
      /(["']authorization["']\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/giu,
      '$1"<redacted>"'
    )
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/giu, '$1<redacted>')
    .replace(
      /(["']?(?:api[_-]?key|apikey|token|secret|password)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/giu,
      '$1"<redacted>"'
    )
    .replace(
      /(["']?(?:api[_-]?key|apikey|token|secret|password)["']?\s*[:=]\s*)(?!["'])[^\s'";,}]+/giu,
      '$1<redacted>'
    );
  for (const sensitivePath of sensitivePaths) {
    const pattern = sensitivePathPattern(sensitivePath);
    if (pattern) sanitized = sanitized.replace(pattern, '<redacted-path>');
  }
  return sanitized;
}

const SAFE_PARENT_ENVIRONMENT = [
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'NODE_PATH',
  'PNPM_HOME',
  'LIBCLANG_PATH',
  'CXXFLAGS',
] as const;

const SENSITIVE_PARENT_PATH_ENVIRONMENT = [
  'USERPROFILE',
  'HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'COREPACK_HOME',
  'PNPM_HOME',
  'NODE_PATH',
] as const;

function parentEnvironmentValue(parent: NodeJS.ProcessEnv, name: string): string | undefined {
  const actualName = Object.keys(parent).find((key) => key.toLowerCase() === name.toLowerCase());
  return actualName ? parent[actualName] : undefined;
}

export function qualificationSensitivePaths(
  parent: NodeJS.ProcessEnv,
  additionalPaths: string[]
): string[] {
  const sourceWorkspaceRoot = resolve(process.cwd(), '..', '..');
  const parentPaths = SENSITIVE_PARENT_PATH_ENVIRONMENT.map((name) =>
    parentEnvironmentValue(parent, name)
  ).filter((value): value is string => Boolean(value));
  return [...new Set([sourceWorkspaceRoot, ...additionalPaths.filter(Boolean), ...parentPaths])];
}

export function resolveQualificationCorepackHome(parent: NodeJS.ProcessEnv): string {
  const configuredHome = parentEnvironmentValue(parent, 'COREPACK_HOME');
  const localAppData = parentEnvironmentValue(parent, 'LOCALAPPDATA');
  const candidate =
    configuredHome ?? (localAppData ? join(localAppData, 'node', 'corepack') : undefined);
  if (!candidate) {
    throw new Error('Local Corepack cache is unavailable; qualification refuses network fallback');
  }
  try {
    if (statSync(candidate).isDirectory()) return candidate;
  } catch {
    // Report a path-free, fail-closed error below.
  }
  throw new Error('Local Corepack cache is unavailable; qualification refuses network fallback');
}

type QualificationEnvironmentOptions = {
  profileRoot?: string;
  appData?: string;
  localAppData?: string;
  codeBuddyHome?: string;
  temporaryDirectory?: string;
  workingDirectory?: string;
  deterministicBaseUrl?: string;
  legacyStorage?: boolean;
  corepackHome?: string;
  cargoHome?: string;
  rustupHome?: string;
  nodeDirectory?: string;
};

export function buildQualificationChildEnvironment(
  parent: NodeJS.ProcessEnv,
  options: QualificationEnvironmentOptions
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const safeName of SAFE_PARENT_ENVIRONMENT) {
    const value = parentEnvironmentValue(parent, safeName);
    if (value !== undefined) environment[safeName] = value;
  }
  Object.assign(environment, {
    ELECTRON_IS_DEV: '1',
    NODE_ENV: 'development',
    GOOSE_ALLOWLIST_BYPASS: 'true',
    ENABLE_PLAYWRIGHT: 'true',
    RUST_LOG: 'info',
    CARGO_NET_OFFLINE: 'true',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost,::1',
    COREPACK_ENABLE_NETWORK: '0',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  });
  if (options.corepackHome) environment.COREPACK_HOME = options.corepackHome;
  if (options.cargoHome) environment.CARGO_HOME = options.cargoHome;
  if (options.rustupHome) environment.RUSTUP_HOME = options.rustupHome;
  if (options.nodeDirectory) environment.GOOSE_NODE_DIR = options.nodeDirectory;
  if (options.profileRoot) {
    Object.assign(environment, {
      HOME: options.profileRoot,
      USERPROFILE: options.profileRoot,
      APPDATA: options.appData,
      LOCALAPPDATA: options.localAppData,
      CODEBUDDY_HOME: options.codeBuddyHome,
      TEMP: options.temporaryDirectory,
      TMP: options.temporaryDirectory,
    });
  }
  if (options.legacyStorage) {
    environment.CODEBUDDY_MIGRATE_LEGACY = '1';
    environment.CODEBUDDY_E2E_EXTERNAL_RELAUNCH = '1';
  }
  if (options.workingDirectory) {
    environment.CODEPRO_E2E_WORKING_DIR = options.workingDirectory;
    environment.GOOSE_WORKING_DIR = options.workingDirectory;
  }
  if (options.deterministicBaseUrl) {
    Object.assign(environment, {
      GOOSE_LOCALE: 'zh-CN',
      GOOSE_DEFAULT_PROVIDER: 'openai',
      GOOSE_DEFAULT_MODEL: 'codepro-e2e',
      GOOSE_MODE: 'auto',
      GOOSE_PLANNER_PROVIDER: 'openai',
      GOOSE_PLANNER_MODEL: 'codepro-e2e',
      GOOSE_PLANNER_FALLBACK_MODEL: 'codepro-e2e',
      GOOSE_CODER_PROVIDER: 'openai',
      GOOSE_CODER_MODEL: 'codepro-e2e',
      GOOSE_CODER_FALLBACK_MODEL: 'codepro-e2e',
      GOOSE_TESTER_PROVIDER: 'openai',
      GOOSE_TESTER_MODEL: 'codepro-e2e',
      GOOSE_TESTER_FALLBACK_MODEL: 'codepro-e2e',
      GOOSE_REVIEWER_PROVIDER: 'openai',
      GOOSE_REVIEWER_MODEL: 'codepro-e2e',
      GOOSE_REVIEWER_FALLBACK_MODEL: 'codepro-e2e',
      GOOSE_DISABLE_KEYRING: 'true',
      OPENAI_API_KEY: 'codepro-e2e-local-only',
      OPENAI_BASE_URL: `${options.deterministicBaseUrl}/v1`,
      OPENAI_BASE_PATH: 'v1/chat/completions',
    });
  }
  return environment;
}

export type LauncherExitState = {
  pid: number | null;
  exited: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
};

export function resetLauncherExitState(
  _previous: LauncherExitState,
  pid: number | undefined
): LauncherExitState {
  return { pid: pid ?? null, exited: false, exitCode: null, exitSignal: null };
}

type CleanupStep = 'completed' | 'not_needed' | 'failed' | 'timed_out';
type CleanupStepOutcome = { status: CleanupStep; error?: string };
type CleanupTasks = Partial<
  Record<
    | 'browserClose'
    | 'electronTreeKill'
    | 'launcherTreeKill'
    | 'serverClose'
    | 'launcherClose'
    | 'stdoutDrain'
    | 'stderrDrain',
    Promise<void>
  >
>;
export type QualificationCleanupOutcome = {
  status: Exclude<CleanupStep, 'not_needed'>;
  browserClose: CleanupStepOutcome;
  electronTreeKill: CleanupStepOutcome;
  launcherTreeKill: CleanupStepOutcome;
  serverClose: CleanupStepOutcome;
  launcherClose: CleanupStepOutcome;
  stdoutDrain: CleanupStepOutcome;
  stderrDrain: CleanupStepOutcome;
};

async function boundedCleanupStep(
  task: Promise<void> | undefined,
  timeoutMs: number,
  sensitivePaths: string[]
): Promise<CleanupStepOutcome> {
  if (!task) return { status: 'not_needed' };
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<CleanupStepOutcome>((resolve) => {
    timeout = setTimeout(() => resolve({ status: 'timed_out' }), timeoutMs);
  });
  const settled = task.then<CleanupStepOutcome>(
    () => ({ status: 'completed' }),
    (error: unknown) => ({
      status: 'failed',
      error: sanitizeQualificationEvidence(
        error instanceof Error ? error.message : String(error),
        sensitivePaths
      ),
    })
  );
  const result = await Promise.race([settled, timedOut]);
  if (timeout) clearTimeout(timeout);
  return result;
}

export async function waitForQualificationCleanup(
  tasks: CleanupTasks,
  timeoutMs: number,
  sensitivePaths: string[]
): Promise<QualificationCleanupOutcome> {
  const [
    browserClose,
    electronTreeKill,
    launcherTreeKill,
    serverClose,
    launcherClose,
    stdoutDrain,
    stderrDrain,
  ] = await Promise.all([
    boundedCleanupStep(tasks.browserClose, timeoutMs, sensitivePaths),
    boundedCleanupStep(tasks.electronTreeKill, timeoutMs, sensitivePaths),
    boundedCleanupStep(tasks.launcherTreeKill, timeoutMs, sensitivePaths),
    boundedCleanupStep(tasks.serverClose, timeoutMs, sensitivePaths),
    boundedCleanupStep(tasks.launcherClose, timeoutMs, sensitivePaths),
    boundedCleanupStep(tasks.stdoutDrain, timeoutMs, sensitivePaths),
    boundedCleanupStep(tasks.stderrDrain, timeoutMs, sensitivePaths),
  ]);
  const steps = [
    browserClose,
    electronTreeKill,
    launcherTreeKill,
    serverClose,
    launcherClose,
    stdoutDrain,
    stderrDrain,
  ];
  const status = steps.some((step) => step.status === 'timed_out')
    ? 'timed_out'
    : steps.some((step) => step.status === 'failed')
      ? 'failed'
      : 'completed';
  return {
    status,
    browserClose,
    electronTreeKill,
    launcherTreeKill,
    serverClose,
    launcherClose,
    stdoutDrain,
    stderrDrain,
  };
}

function waitForLauncherClose(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('close', () => resolve()));
}

type WindowsProcessTreeCleanupDependencies = {
  probe: (pid: number) => boolean;
  taskkill: (pid: number) => Promise<void>;
  gracePeriodMs?: number;
};

type WindowsProcessTreeCleanupOptions = {
  authoritativeGracefulClose?: boolean;
};

const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;
const WINDOWS_LAUNCHER_GRACE_PERIOD_MS = 5_000;
const QUALIFICATION_CLEANUP_SETTLE_RESERVE_MS = 2_000;
const QUALIFICATION_CLEANUP_TIMEOUT_MS = 12_500;
if (
  QUALIFICATION_CLEANUP_TIMEOUT_MS <=
  WINDOWS_LAUNCHER_GRACE_PERIOD_MS +
    WINDOWS_TASKKILL_TIMEOUT_MS +
    QUALIFICATION_CLEANUP_SETTLE_RESERVE_MS
) {
  throw new Error('Qualification cleanup budget must cover graceful close, taskkill, and settle');
}

const defaultWindowsProcessTreeCleanupDependencies: WindowsProcessTreeCleanupDependencies = {
  probe: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  },
  taskkill: (pid) =>
    execFileAsync('taskkill', ['/F', '/T', '/PID', String(pid)], {
      timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
    }).then(() => undefined),
  gracePeriodMs: WINDOWS_LAUNCHER_GRACE_PERIOD_MS,
};

function isOnlyAlreadyExitedTaskkillError(error: unknown): boolean {
  const taskkillError = error as { code?: unknown; stderr?: unknown };
  if (taskkillError.code !== 128 && taskkillError.code !== '128') return false;
  if (typeof taskkillError.stderr !== 'string') return false;

  const diagnosticLines = taskkillError.stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (diagnosticLines.length === 0 || diagnosticLines.length % 2 !== 0) return false;

  for (let index = 0; index < diagnosticLines.length; index += 2) {
    if (
      !/^ERROR: The process with PID \d+(?: \(child process of PID \d+\))? could not be terminated\.$/iu.test(
        diagnosticLines[index]
      ) ||
      !/^Reason: There is no running instance of the task\.$/iu.test(diagnosticLines[index + 1])
    ) {
      return false;
    }
  }

  return true;
}

export function createWindowsProcessTreeCleanupTask(
  pid: number | undefined,
  gracefulClose: Promise<void> | undefined,
  dependencies = defaultWindowsProcessTreeCleanupDependencies,
  options: WindowsProcessTreeCleanupOptions = {}
): Promise<void> | undefined {
  if (!pid) return undefined;
  let initiallyRunning: boolean;
  try {
    initiallyRunning = dependencies.probe(pid);
  } catch (error) {
    return Promise.reject(error);
  }
  if (!initiallyRunning) return undefined;

  return (async () => {
    let gracefulCloseCompleted = false;
    if (gracefulClose) {
      let graceTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          gracefulClose.then(
            () => {
              gracefulCloseCompleted = true;
            },
            () => undefined
          ),
          new Promise<void>((resolve) => {
            graceTimer = setTimeout(
              resolve,
              dependencies.gracePeriodMs ?? WINDOWS_LAUNCHER_GRACE_PERIOD_MS
            );
          }),
        ]);
      } finally {
        if (graceTimer) clearTimeout(graceTimer);
      }
    }
    if (options.authoritativeGracefulClose && gracefulCloseCompleted) {
      return;
    }
    if (!dependencies.probe(pid)) return;

    try {
      await dependencies.taskkill(pid);
    } catch (error) {
      if (!isOnlyAlreadyExitedTaskkillError(error)) throw error;
      if (dependencies.probe(pid)) {
        throw new Error('Windows process tree remained after an already-exited cleanup race');
      }
      return;
    }

    if (dependencies.probe(pid)) {
      throw new Error('Windows process tree remained after cleanup');
    }
  })();
}

export function waitForPipeDrain(stream: Readable | null | undefined): Promise<void> {
  if (!stream || stream.destroyed || stream.readableEnded) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const removeListeners = () => {
      stream.off('end', finish);
      stream.off('close', finish);
      stream.off('error', fail);
    };
    const finish = () => {
      removeListeners();
      resolve();
    };
    const fail = (error: Error) => {
      removeListeners();
      reject(error);
    };
    stream.once('end', finish);
    stream.once('close', finish);
    stream.once('error', fail);
  });
}

export type ProfileMode = 'isolated' | 'ambient';
export type StorageFixtureMode = 'fresh' | 'legacy';

type GooseTestFixtures = {
  appPage: Page;
  goosePage: Page;
  profileMode: ProfileMode;
  storageFixtureMode: StorageFixtureMode;
  isolatedProfileRoot: string;
  initialWorkingDir: string;
  executablePathPrefix: string;
  commandPathOverride: string | undefined;
  registerArtifactCleanup: (path: string) => void;
};

export const test = base.extend<GooseTestFixtures>({
  profileMode: ['isolated', { option: true }],
  storageFixtureMode: ['fresh', { option: true }],
  initialWorkingDir: ['', { option: true }],
  executablePathPrefix: ['', { option: true }],
  commandPathOverride: [undefined, { option: true }],

  registerArtifactCleanup: async ({}, use) => {
    const paths: string[] = [];
    await use((path) => paths.push(path));
    for (const path of paths.reverse()) {
      rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  },

  isolatedProfileRoot: async ({ profileMode }, use) => {
    if (profileMode !== 'isolated') {
      await use('');
      return;
    }
    const profileRoot = mkdtempSync(join(tmpdir(), 'codebuddy-e2e-'));
    try {
      await use(profileRoot);
    } finally {
      rmSync(profileRoot, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      });
    }
  },

  appPage: async (
    {
      profileMode,
      storageFixtureMode,
      isolatedProfileRoot,
      initialWorkingDir,
      executablePathPrefix,
      commandPathOverride,
      registerArtifactCleanup: _registerArtifactCleanup,
    },
    use,
    testInfo
  ) => {
    let appProcess: ChildProcess | undefined;
    let browser: Browser | undefined;
    let electronBrowserPid: number | undefined;
    let launcherExitState: LauncherExitState = {
      pid: null,
      exited: false,
      exitCode: null,
      exitSignal: null,
    };
    let deterministicServer: Awaited<ReturnType<typeof startDeterministicOpenAiServer>> | undefined;
    let output = '';
    let stdout = '';
    let stderr = '';
    let lastConnectionError = '';
    const corepackHome = resolveQualificationCorepackHome(process.env);
    const parentProfile =
      parentEnvironmentValue(process.env, 'USERPROFILE') ??
      parentEnvironmentValue(process.env, 'HOME');
    const cargoHome =
      parentEnvironmentValue(process.env, 'CARGO_HOME') ??
      (parentProfile ? join(parentProfile, '.cargo') : undefined);
    const rustupHome =
      parentEnvironmentValue(process.env, 'RUSTUP_HOME') ??
      (parentProfile ? join(parentProfile, '.rustup') : undefined);
    let nodeDirectory = dirname(process.execPath);
    if (profileMode === 'isolated' && testInfo.title.startsWith('Toolbox MCP ')) {
      nodeDirectory = join(isolatedProfileRoot, 'offline-node');
      mkdirSync(nodeDirectory, { recursive: true });
      writeFileSync(join(nodeDirectory, 'node-v22.14.0.installed'), '', 'utf8');
      const filesystemServer = resolve(
        process.cwd(),
        '..',
        'node_modules',
        '@modelcontextprotocol',
        'server-filesystem',
        'dist',
        'index.js'
      );
      writeFileSync(
        join(nodeDirectory, 'npx.cmd'),
        [
          '@echo off',
          'if /I not "%~1"=="-y" exit /b 87',
          'if /I not "%~2"=="@modelcontextprotocol/server-filesystem@2026.8.31" exit /b 87',
          'shift',
          'shift',
          `"${process.execPath}" "${filesystemServer}" %*`,
          '',
        ].join('\r\n'),
        'utf8'
      );
    }
    const sensitivePaths = qualificationSensitivePaths(process.env, [
      isolatedProfileRoot,
      initialWorkingDir,
      executablePathPrefix,
      corepackHome,
      cargoHome ?? '',
      rustupHome ?? '',
    ]);

    let childEnvironment = buildQualificationChildEnvironment(process.env, {
      workingDirectory: initialWorkingDir,
      corepackHome,
      cargoHome,
      rustupHome,
      nodeDirectory,
    });

    if (profileMode === 'isolated') {
      const permissionPersistenceScenario = testInfo.title.startsWith('Permission ');
      deterministicServer = await startDeterministicOpenAiServer({
        scenario: testInfo.title.startsWith('P0 ')
          ? 'p0-repair'
          : testInfo.title.startsWith('Toolbox MCP ')
            ? 'mcp-filesystem'
            : testInfo.title.startsWith('Toolbox capability ')
              ? 'toolbox-capability-toggle'
              : testInfo.title.startsWith('Toolbox Computer ')
                ? 'computer-toggle'
                : testInfo.title.startsWith('Skills ')
                  ? 'skill-management'
                  : testInfo.title.startsWith('Project Memory ')
                    ? 'project-memory'
                    : permissionPersistenceScenario
                      ? 'permission-persistence'
                      : testInfo.title.startsWith('Message identity ')
                        ? 'message-identity'
                        : 'default',
      });
      const profileRoot = isolatedProfileRoot;
      const appData = join(profileRoot, 'AppData', 'Roaming');
      const localAppData = join(profileRoot, 'AppData', 'Local');
      const codeBuddyHome = join(profileRoot, '.CodeBuddy');
      const temporaryDirectory = join(profileRoot, 'Temp');
      mkdirSync(appData, { recursive: true });
      mkdirSync(localAppData, { recursive: true });
      mkdirSync(temporaryDirectory, { recursive: true });
      const profileConfigDir =
        storageFixtureMode === 'legacy'
          ? join(appData, 'CodeBuddy', 'backend', 'config')
          : join(codeBuddyHome, 'profiles', 'local', 'config');
      mkdirSync(profileConfigDir, { recursive: true });
      writeFileSync(
        join(profileConfigDir, 'config.yaml'),
        [
          'GOOSE_PROVIDER: openai',
          'GOOSE_MODEL: codepro-e2e',
          `GOOSE_MODE: ${permissionPersistenceScenario ? 'approve' : 'auto'}`,
          'GOOSE_DISABLE_KEYRING: true',
          'GOOSE_PLANNER_PROVIDER: openai',
          'GOOSE_PLANNER_MODEL: codepro-e2e',
          'GOOSE_PLANNER_FALLBACK_MODEL: codepro-e2e',
          'GOOSE_CODER_PROVIDER: openai',
          'GOOSE_CODER_MODEL: codepro-e2e',
          'GOOSE_CODER_FALLBACK_MODEL: codepro-e2e',
          'GOOSE_TESTER_PROVIDER: openai',
          'GOOSE_TESTER_MODEL: codepro-e2e',
          'GOOSE_TESTER_FALLBACK_MODEL: codepro-e2e',
          'GOOSE_REVIEWER_PROVIDER: openai',
          'GOOSE_REVIEWER_MODEL: codepro-e2e',
          'GOOSE_REVIEWER_FALLBACK_MODEL: codepro-e2e',
          ...(initialWorkingDir
            ? [`GOOSE_WORKING_DIR: '${initialWorkingDir.replaceAll("'", "''")}'`]
            : []),
          `OPENAI_BASE_URL: ${deterministicServer.baseUrl}/v1`,
          'OPENAI_BASE_PATH: v1/chat/completions',
          '',
        ].join('\n'),
        'utf8'
      );
      if (storageFixtureMode === 'legacy') {
        writeFileSync(
          join(appData, 'CodeBuddy', 'settings.json'),
          JSON.stringify({ locale: 'zh-CN', source: 'legacy-storage-fixture' }, null, 2),
          'utf8'
        );
      }
      childEnvironment = buildQualificationChildEnvironment(process.env, {
        profileRoot,
        appData,
        localAppData,
        codeBuddyHome,
        temporaryDirectory,
        workingDirectory: initialWorkingDir,
        deterministicBaseUrl: deterministicServer.baseUrl,
        legacyStorage: storageFixtureMode === 'legacy',
        corepackHome,
        cargoHome,
        rustupHome,
        nodeDirectory,
      });
      if (permissionPersistenceScenario) childEnvironment.GOOSE_MODE = 'approve';
      if (testInfo.title.startsWith('Toolbox capability ')) {
        childEnvironment.GOOSE_MOIM_MESSAGE_TEXT = 'TOOLBOX_TOM_CONTEXT_ACTIVE';
      }
      if (testInfo.title.startsWith('Skills Download ')) {
        childEnvironment.NO_PROXY =
          '127.0.0.1,localhost,::1,github.com,api.github.com,raw.githubusercontent.com';
      }
    }

    if (commandPathOverride !== undefined) {
      for (const key of Object.keys(childEnvironment))
        if (key.toLowerCase() === 'path') delete childEnvironment[key];
      childEnvironment.PATH = commandPathOverride;
    }
    if (executablePathPrefix) {
      childEnvironment.PATH = [executablePathPrefix, childEnvironment.PATH]
        .filter(Boolean)
        .join(delimiter);
    }

    const debugPort = await allocateLoopbackPort();
    childEnvironment.PLAYWRIGHT_DEBUG_PORT = String(debugPort);
    childEnvironment.CODEBUDDY_PREVIEW_DEVTOOLS_PORT = String(debugPort);
    childEnvironment.CODEBUDDY_NODE = process.execPath;

    const command =
      process.platform === 'win32'
        ? {
            executable: 'powershell.exe',
            args: ['-NoProfile', '-File', join(__dirname, '../../../../start-preview.ps1')],
          }
        : {
            executable: 'pnpm',
            args: ['run', 'start-gui'],
          };

    // Preserve bounded, sanitized startup evidence even if fixture setup times
    // out before its teardown can attach diagnostics.
    const liveLogPaths = {
      stdout: testInfo.outputPath('electron-stdout.txt'),
      stderr: testInfo.outputPath('electron-stderr.txt'),
    };
    const rememberOutput = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      output = boundedOutput(output, chunk);
      if (stream === 'stdout') stdout = boundedOutput(stdout, chunk);
      else stderr = boundedOutput(stderr, chunk);
      writeFileSync(
        liveLogPaths[stream],
        sanitizeQualificationEvidence(stream === 'stdout' ? stdout : stderr, sensitivePaths),
        'utf8'
      );
      if (process.env.DEBUG_TESTS === '1') {
        (stream === 'stdout' ? process.stdout : process.stderr).write(chunk);
      }
    };

    const launchApplication = (): ChildProcess => {
      const child = spawn(command.executable, command.args, {
        cwd: join(__dirname, '../..'),
        env: childEnvironment,
        stdio: 'pipe',
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      launcherExitState = resetLauncherExitState(launcherExitState, child.pid);
      child.stdout?.on('data', (chunk: Buffer) => rememberOutput('stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer) => rememberOutput('stderr', chunk));
      child.once('exit', (code, signal) => {
        launcherExitState.exited = true;
        launcherExitState.exitCode = code;
        launcherExitState.exitSignal = signal;
      });
      return child;
    };

    try {
      appProcess = launchApplication();

      // A clean Windows checkout may spend several minutes compiling the Rust backend before
      // Electron opens its CDP endpoint. Keep polling within the enclosing Playwright timeout.
      for (let attempt = 0; attempt < 2_400; attempt += 1) {
        try {
          const websocketEndpoint = output.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
          browser = await chromium.connectOverCDP(
            websocketEndpoint ?? `http://127.0.0.1:${debugPort}`
          );
          break;
        } catch (error) {
          lastConnectionError = error instanceof Error ? error.message : String(error);
          if (launcherExitState.exited && storageFixtureMode !== 'legacy') break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }

      if (!browser) {
        const safeError = sanitizeQualificationEvidence(
          `${lastConnectionError}\n${output}`,
          sensitivePaths
        );
        throw new Error(
          `CodeBuddy did not expose CDP. Last connection error and output:\n${safeError}`
        );
      }

      let page: Page | undefined;
      let externallyRestarted = false;
      for (let attempt = 0; attempt < 1_200; attempt += 1) {
        if (storageFixtureMode === 'legacy' && launcherExitState.exited && !externallyRestarted) {
          output = `${output}\n[qualification] restarting full Electron Forge launch\n`;
          browser = undefined;
          electronBrowserPid = undefined;
          appProcess = launchApplication();
          externallyRestarted = true;
        }
        if (!browser?.isConnected() || attempt % 8 === 0) {
          try {
            browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
          } catch (error) {
            lastConnectionError = error instanceof Error ? error.message : String(error);
            await new Promise((resolve) => setTimeout(resolve, 250));
            continue;
          }
        }
        const pages = browser.contexts().flatMap((context) => context.pages());
        for (const candidate of pages) {
          try {
            if (await candidate.locator('#root').isVisible({ timeout: 100 })) {
              page = candidate;
              break;
            }
          } catch {
            // The migration process may relaunch while this page is inspected.
          }
        }
        if (page) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!page) {
        throw new Error(
          `CodeBuddy did not create a window.\n${sanitizeQualificationEvidence(output, sensitivePaths)}`
        );
      }

      if (initialWorkingDir) {
        const requestDir = await page.evaluate(() => window.appConfig?.get('REQUEST_DIR'));
        if (requestDir !== initialWorkingDir) {
          await page.evaluate(
            (dir) => window.electron.createChatWindow({ dir }),
            initialWorkingDir
          );
          let workspacePage: Page | undefined;
          for (let attempt = 0; attempt < 120; attempt += 1) {
            const pages = browser.contexts().flatMap((context) => context.pages());
            for (const candidate of pages) {
              try {
                const candidateDir = await candidate.evaluate(() =>
                  window.appConfig?.get('REQUEST_DIR')
                );
                if (candidateDir === initialWorkingDir) {
                  workspacePage = candidate;
                  break;
                }
              } catch {
                // The new chat window may still be loading its preload bridge.
              }
            }
            if (workspacePage) break;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          if (!workspacePage) {
            throw new Error('CodeBuddy did not create the isolated project chat window.');
          }
          page = workspacePage;
          await page.reload({ waitUntil: 'domcontentloaded' });
        }
      }

      await page.waitForLoadState('domcontentloaded');
      await page.locator('#root').waitFor({ state: 'visible', timeout: 30_000 });
      try {
        const browserSession = await browser.newBrowserCDPSession();
        const processInfo = await browserSession.send('SystemInfo.getProcessInfo');
        electronBrowserPid = processInfo.processInfo.find((entry) => entry.type === 'browser')?.id;
        await browserSession.detach();
      } catch {
        // Process cleanup still has the launcher-tree fallback below.
      }
      if (deterministicServer && testInfo.title.startsWith('Message identity ')) {
        await page.evaluate(async (url) => {
          const modulePath = '/src/acp/acpConnection.ts';
          const { getAcpClient } = await import(modulePath);
          const client = await getAcpClient();
          const { providerId } = await client.goose.providersCustomCreate_unstable({
            engine: 'openai_compatible',
            displayName: 'Identity fixture',
            apiUrl: url,
            requiresAuth: false,
            models: ['codepro-e2e'],
            supportsStreaming: true,
          });
          await client.goose.defaultsSave_unstable({ providerId, modelId: 'codepro-e2e' });
        }, deterministicServer.baseUrl);
      }
      await use(page);
    } finally {
      const launcherClose = waitForLauncherClose(appProcess);
      const stdoutDrain = waitForPipeDrain(appProcess?.stdout);
      const stderrDrain = waitForPipeDrain(appProcess?.stderr);
      const browserClose = browser?.close();
      const electronTreeKill =
        process.platform === 'win32' && electronBrowserPid
          ? createWindowsProcessTreeCleanupTask(electronBrowserPid, browserClose)
          : undefined;
      const launcherTreeKill = appProcess?.pid
        ? process.platform === 'win32'
          ? createWindowsProcessTreeCleanupTask(
              appProcess.pid,
              launcherClose,
              defaultWindowsProcessTreeCleanupDependencies,
              { authoritativeGracefulClose: true }
            )
          : new Promise<void>((resolve, reject) => {
              try {
                process.kill(-appProcess.pid!, 'SIGTERM');
                resolve();
              } catch (error) {
                reject(error);
              }
            })
        : undefined;
      const serverClose = deterministicServer?.close();
      const cleanup = await waitForQualificationCleanup(
        {
          browserClose,
          electronTreeKill,
          launcherTreeKill,
          serverClose,
          launcherClose,
          stdoutDrain,
          stderrDrain,
        },
        QUALIFICATION_CLEANUP_TIMEOUT_MS,
        sensitivePaths
      );
      const diagnosticFiles = {
        stdout: testInfo.outputPath('electron-stdout.txt'),
        stderr: testInfo.outputPath('electron-stderr.txt'),
        exit: testInfo.outputPath('electron-exit.json'),
        routeTrace: testInfo.outputPath('deterministic-route-trace.json'),
      };
      writeFileSync(
        diagnosticFiles.stdout,
        sanitizeQualificationEvidence(stdout, sensitivePaths),
        'utf8'
      );
      writeFileSync(
        diagnosticFiles.stderr,
        sanitizeQualificationEvidence(stderr, sensitivePaths),
        'utf8'
      );
      writeFileSync(
        diagnosticFiles.exit,
        JSON.stringify(
          {
            launcher: launcherExitState,
            backend: { status: 'not_observed_separately' },
            electronBrowser: { pid: electronBrowserPid ?? null },
            cleanup,
          },
          null,
          2
        ),
        'utf8'
      );
      writeFileSync(
        diagnosticFiles.routeTrace,
        JSON.stringify(deterministicServer?.routeTrace() ?? [], null, 2),
        'utf8'
      );
      await Promise.all([
        testInfo.attach('electron-stdout', {
          path: diagnosticFiles.stdout,
          contentType: 'text/plain',
        }),
        testInfo.attach('electron-stderr', {
          path: diagnosticFiles.stderr,
          contentType: 'text/plain',
        }),
        testInfo.attach('electron-exit', {
          path: diagnosticFiles.exit,
          contentType: 'application/json',
        }),
        testInfo.attach('deterministic-route-trace', {
          path: diagnosticFiles.routeTrace,
          contentType: 'application/json',
        }),
      ]);
    }
  },

  goosePage: async ({ appPage }, use) => use(appPage),
});

export { expect };
