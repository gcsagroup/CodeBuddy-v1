import { spawn, type ChildProcess } from 'child_process';
import fs from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { LEGACY_KEYRING_SERVICE } from './storage/codeBuddyPaths';
import {
  appendTail as appendStartupTail,
  createGooseServeStartupDiagnostics,
  type GooseServeStartupDiagnostics,
} from './startupDiagnostics';

export interface Logger {
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export const defaultLogger: Logger = {
  info: (...args) => console.log('[goose-serve]', ...args),
  error: (...args) => console.error('[goose-serve]', ...args),
};

export interface FindGooseBinaryOptions {
  isPackaged?: boolean;
  resourcesPath?: string;
}

type ReadinessFetchInit = Parameters<typeof globalThis.fetch>[1];
export type GooseServeExitSignal = ChildProcess['signalCode'];
type ReadinessFetch = (input: string, init?: ReadinessFetchInit) => Promise<Response>;

export const isLoopbackTlsReadinessUrl = (input: string): boolean => {
  try {
    const url = new URL(input);
    return url.protocol === 'https:' && url.hostname === '127.0.0.1' && url.pathname === '/status';
  } catch {
    return false;
  }
};

const defaultReadinessFetch: ReadinessFetch = async (input, init) => {
  if (!isLoopbackTlsReadinessUrl(input)) {
    return globalThis.fetch(input, init);
  }

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void) => {
      if (!settled) {
        settled = true;
        action();
      }
    };

    const request = httpsRequest(
      input,
      {
        method: 'GET',
        rejectUnauthorized: false,
        signal: init?.signal ?? undefined,
      },
      (response) => {
        const cleanupAndResolve = (status: number) => {
          settle(() => {
            response.destroy();
            resolve(new Response(null, { status }));
          });
        };
        const cleanupAndReject = (err: Error) => {
          settle(() => {
            response.destroy();
            reject(err);
          });
        };

        response.once('end', () => cleanupAndResolve(response.statusCode ?? 500));
        response.once('error', cleanupAndReject);
        response.once('aborted', () => cleanupAndReject(new Error('Readiness response aborted')));
        response.once('close', () => {
          // If the response closed without ever emitting 'end', make sure we
          // reject instead of leaving fetchStatus hanging forever.
          if (!settled) {
            cleanupAndReject(new Error('Readiness response closed unexpectedly'));
          }
        });
        response.resume();
      }
    );

    // Defensive: if the caller's signal never fires and the socket stalls,
    // impose our own 2-second ceiling so waitForGooseServeReady can retry.
    const hardTimeout = setTimeout(() => {
      settle(() => {
        request.destroy(new Error('Readiness request hard timeout'));
        reject(new Error('Readiness request hard timeout'));
      });
    }, 2000);

    request.once('error', (err) => {
      clearTimeout(hardTimeout);
      settle(() => reject(err));
    });
    request.once('timeout', () => {
      clearTimeout(hardTimeout);
      settle(() => {
        request.destroy(new Error('Readiness request socket timeout'));
        reject(new Error('Readiness request socket timeout'));
      });
    });
    request.once('close', () => clearTimeout(hardTimeout));
    request.end();
  });
};

export interface StartGooseServeOptions extends FindGooseBinaryOptions {
  dir?: string;
  serverSecret: string;
  tls?: boolean;
  env?: Record<string, string | undefined>;
  logger?: Logger;
  diagnosticsDir?: string;
  codeProUnifiedMode?: boolean;
  readinessFetch?: ReadinessFetch;
}

export interface GooseServeResult {
  acpUrl: string;
  workingDir: string;
  process: ChildProcess;
  errorLog: string[];
  certFingerprint: string | null;
  cleanup: () => Promise<void>;
  hasExited: () => boolean;
  getExitDetails: () => { code: number | null; signal: GooseServeExitSignal };
  startupDiagnosticsPath: string | null;
  getStartupDiagnostics: () => GooseServeStartupDiagnostics | null;
  recordStartupEvent: (name: string, details?: Record<string, unknown>) => void;
}

const existingFile = (candidate: string): boolean => {
  try {
    return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
};

export const findGooseBinaryPath = (options: FindGooseBinaryOptions = {}): string => {
  const { isPackaged = false, resourcesPath } = options;
  const pathFromEnv = process.env.CODEBUDDY_BINARY ?? process.env.GOOSE_BINARY;
  if (pathFromEnv) {
    if (isPackaged) {
      throw new Error('Backend binary overrides are only supported in development builds');
    }

    const resolvedPath = path.resolve(pathFromEnv);
    if (existingFile(resolvedPath)) {
      return resolvedPath;
    }
    throw new Error(`Invalid CodeBuddy backend path: ${pathFromEnv} (pwd is ${process.cwd()})`);
  }

  const binaryName = process.platform === 'win32' ? 'goose.exe' : 'goose';
  const possiblePaths: string[] = [];

  if (isPackaged && resourcesPath) {
    possiblePaths.push(path.join(resourcesPath, 'bin', binaryName));
    possiblePaths.push(path.join(resourcesPath, binaryName));
  } else {
    const stagedPath = path.join(process.cwd(), 'src', 'bin', binaryName);
    const debugPath = path.join(process.cwd(), '..', '..', 'target', 'debug', binaryName);
    if (
      existingFile(stagedPath) &&
      existingFile(debugPath) &&
      fs.statSync(debugPath).mtimeMs > fs.statSync(stagedPath).mtimeMs
    ) {
      return debugPath;
    }
    possiblePaths.push(
      stagedPath,
      path.join(process.cwd(), '..', '..', 'target', 'release', binaryName),
      debugPath
    );
  }

  for (const candidate of possiblePaths) {
    if (existingFile(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `CodeBuddy backend binary not found in any of the possible paths: ${possiblePaths.join(', ')}`
  );
};

const findAvailablePort = (): Promise<number> => {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => {
        resolve(port);
      });
    });
  });
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isFatalError = (line: string): boolean => {
  const fatalPatterns = [/panicked at/, /RUST_BACKTRACE/, /fatal error/i];
  return fatalPatterns.some((pattern) => pattern.test(line));
};

const appendErrorTail = (target: string[], lines: string[], maxLines = 100): void => {
  for (const line of lines) {
    if (line.trim()) {
      target.push(line);
    }
  }
  if (target.length > maxLines) {
    target.splice(0, target.length - maxLines);
  }
};

const CERT_FINGERPRINT_PREFIX = 'GOOSED_CERT_FINGERPRINT=';
const TLS_FINGERPRINT_TIMEOUT_MS = 5000;

const fetchStatus = async (statusUrl: string, readinessFetch: ReadinessFetch): Promise<boolean> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);

  try {
    const response = await readinessFetch(statusUrl, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
};

const waitForFingerprint = async (
  fingerprintReady: Promise<string | null>,
  timeoutMs: number
): Promise<string | null> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    timeout = setTimeout(() => resolve(null), timeoutMs);
  });

  try {
    return await Promise.race([fingerprintReady, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

const waitForGooseServeReady = async (
  statusUrl: string,
  errorLog: string[],
  shouldStopWaiting: () => boolean,
  options: {
    healthUrl: string;
    readinessFetch: ReadinessFetch;
    timeoutMs: number;
    onEvent?: (name: string, details?: Record<string, unknown>) => void;
  }
): Promise<boolean> => {
  const timeout = options.timeoutMs;
  const interval = 100;
  const deadline = Date.now() + timeout;
  const probeDetails = {
    transport: statusUrl.startsWith('https:') ? 'https' : 'plain-http',
    method: 'GET',
    path: '/status',
    url: statusUrl,
    statusUrl,
    healthUrl: options.healthUrl,
  };
  options.onEvent?.('healthcheck_start', {
    ...probeDetails,
    timeoutMs: timeout,
    intervalMs: interval,
  });

  let attempt = 1;
  while (Date.now() < deadline) {
    if (shouldStopWaiting()) {
      options.onEvent?.('healthcheck_fatal_error', {
        ...probeDetails,
        attempt,
        reason: 'process_unavailable',
      });
      return false;
    }

    if (errorLog.some(isFatalError)) {
      options.onEvent?.('healthcheck_fatal_error', {
        ...probeDetails,
        attempt,
        reason: 'fatal_stderr',
      });
      return false;
    }

    if (await fetchStatus(statusUrl, options.readinessFetch)) {
      options.onEvent?.('healthcheck_success', {
        ...probeDetails,
        attempt,
      });
      return true;
    }

    await delay(interval);
    attempt += 1;
  }

  options.onEvent?.('healthcheck_timeout', { ...probeDetails, timeoutMs: timeout });
  return false;
};

export const getGooseServeReadinessTimeout = (isPackaged: boolean | undefined): number =>
  isPackaged === false ? 90_000 : 30_000;

export const formatBackendExitDetails = (
  exitCode: number | null,
  exitSignal: GooseServeExitSignal,
  platform: typeof process.platform = process.platform
): string => {
  if (platform === 'win32' && exitCode !== null && exitCode >>> 0 === 0xc0000135) {
    return ' CodeBuddy 后端缺少运行时依赖，或者安装包不完整（0xC0000135 / STATUS_DLL_NOT_FOUND）。请重新安装完整的 CodeBuddy 安装包；若仍失败，请安装或修复 Microsoft Visual C++ 2015–2022 Redistributable (x64)。';
  }
  return ` Process exited with code ${exitCode} and signal ${exitSignal}.`;
};

export type LocalServeScheme = 'http' | 'https';

export interface LocalServeUrls {
  httpBaseUrl: string;
  statusUrl: string;
  healthUrl: string;
  acpUrl: string;
  redactedAcpUrl: string;
}

export const buildLocalServeUrls = (
  port: number,
  token: string,
  scheme: LocalServeScheme
): LocalServeUrls => {
  const httpBaseUrl = `${scheme}://127.0.0.1:${port}`;
  const websocketProtocol = scheme === 'https' ? 'wss:' : 'ws:';

  const acpUrl = new URL(`${httpBaseUrl}/acp`);
  acpUrl.protocol = websocketProtocol;
  acpUrl.searchParams.set('token', token);

  const redactedAcpUrl = new URL(`${httpBaseUrl}/acp`);
  redactedAcpUrl.protocol = websocketProtocol;
  redactedAcpUrl.searchParams.set('token', 'REDACTED');

  return {
    httpBaseUrl,
    statusUrl: `${httpBaseUrl}/status`,
    healthUrl: `${httpBaseUrl}/health`,
    acpUrl: acpUrl.toString(),
    redactedAcpUrl: redactedAcpUrl.toString(),
  };
};

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

const withStartupDiagnosticsPath = (
  message: string,
  startupDiagnosticsPath: string | null
): string => {
  if (!startupDiagnosticsPath) {
    return message;
  }
  return `${message} Startup diagnostics: ${startupDiagnosticsPath}`;
};

// Reuse the existing secure namespace; renaming it would hide saved credentials.
const CODEBUDDY_KEYRING_SERVICE = LEGACY_KEYRING_SERVICE;
const CODEBUDDY_LEGACY_KEYRING_SERVICE = 'goose';

export const buildGooseServeEnv = (
  serverSecret: string,
  binaryPath: string,
  additionalEnv: Record<string, string | undefined>
): Record<string, string | undefined> => {
  const homeDir = process.env.HOME || os.homedir();
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const currentPath = process.env[pathKey] || '';

  const env: Record<string, string | undefined> = {
    ...process.env,
    CODEPRO_RUNTIME_MODE: process.env.CODEPRO_RUNTIME_MODE ?? 'durable',
    HOME: homeDir,
    [pathKey]: `${path.dirname(binaryPath)}${path.delimiter}${currentPath}`,
  };

  if (process.platform === 'win32') {
    env.USERPROFILE = homeDir;
    env.APPDATA = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    env.LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
  }

  for (const [key, value] of Object.entries(additionalEnv)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  env.GOOSE_KEYRING_SERVICE = CODEBUDDY_KEYRING_SERVICE;
  env.GOOSE_KEYRING_LEGACY_SERVICE = CODEBUDDY_LEGACY_KEYRING_SERVICE;
  env.CODEBUDDY_SERVER__SECRET_KEY = serverSecret;
  env.GOOSE_SERVER__SECRET_KEY = serverSecret;

  return env;
};

export const startGooseServe = async ({
  dir,
  serverSecret,
  tls = false,
  env: additionalEnv = {},
  isPackaged,
  resourcesPath,
  logger = defaultLogger,
  diagnosticsDir,
  codeProUnifiedMode = false,
  readinessFetch = defaultReadinessFetch,
}: StartGooseServeOptions): Promise<GooseServeResult> => {
  const workingDir = dir || process.cwd();
  const startupTrace = createGooseServeStartupDiagnostics(diagnosticsDir, workingDir, {
    codeProUnifiedMode,
  });
  const startupDiagnosticsPath = startupTrace?.diagnosticsPath ?? null;
  const secretKey = serverSecret.trim();
  if (!secretKey) {
    const message = 'CodeBuddy server secret is required to start the local backend';
    startupTrace?.record('configuration_error', { message });
    throw new Error(withStartupDiagnosticsPath(message, startupDiagnosticsPath));
  }

  let goosePath: string;
  try {
    goosePath = findGooseBinaryPath({ isPackaged, resourcesPath });
  } catch (error) {
    const message = errorMessage(error);
    startupTrace?.record('binary_resolve_error', { message });
    throw new Error(withStartupDiagnosticsPath(message, startupDiagnosticsPath));
  }

  const port = await findAvailablePort();
  const localServeScheme: LocalServeScheme = tls ? 'https' : 'http';
  const { httpBaseUrl, statusUrl, healthUrl, acpUrl, redactedAcpUrl } = buildLocalServeUrls(
    port,
    secretKey,
    localServeScheme
  );
  const errorLog: string[] = [];
  const args = [
    'serve',
    ...(tls ? ['--tls'] : []),
    '--platform',
    'desktop',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
  ];

  logger.info(
    `Starting CodeBuddy backend from: ${goosePath} on port ${port} in dir ${workingDir}`
  );
  if (startupTrace) {
    startupTrace.diagnostics.binaryPath = goosePath;
    startupTrace.diagnostics.httpBaseUrl = httpBaseUrl;
    startupTrace.diagnostics.readinessUrl = statusUrl;
    startupTrace.diagnostics.statusUrl = statusUrl;
    startupTrace.diagnostics.healthUrl = healthUrl;
    startupTrace.diagnostics.acpUrl = redactedAcpUrl;
    startupTrace.record('spawn_start', {
      binaryPath: goosePath,
      port,
      tls,
      workingDir,
      args,
    });
  }

  const spawnOptions = {
    env: buildGooseServeEnv(secretKey, goosePath, additionalEnv),
    cwd: workingDir,
    windowsHide: true,
    shell: false as const,
    stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
  };

  const gooseProcess = spawn(goosePath, args, spawnOptions);
  if (startupTrace) {
    startupTrace.diagnostics.pid = gooseProcess.pid ?? null;
    startupTrace.record('spawn_success', { pid: gooseProcess.pid ?? null });
  }

  let exited = false;
  let spawnFailed = false;
  let exitCode: number | null = null;
  let exitSignal: GooseServeExitSignal = null;
  let certFingerprint: string | null = null;
  let stdoutBuffer = '';
  let stdoutCollectionStopped = false;
  let fingerprintReadyResolved = false;
  let resolveFingerprintReady: (fingerprint: string | null) => void = () => {};
  const fingerprintReady = new Promise<string | null>((resolve) => {
    resolveFingerprintReady = resolve;
  });

  const resolveFingerprint = (fingerprint: string | null) => {
    if (fingerprintReadyResolved) {
      return;
    }
    fingerprintReadyResolved = true;
    resolveFingerprintReady(fingerprint);
  };

  const stopStdoutCollection = () => {
    if (stdoutCollectionStopped) {
      return;
    }
    stdoutCollectionStopped = true;
    gooseProcess.stdout?.off('data', onStdoutData);
    gooseProcess.stdout?.resume();
  };

  const recordCertFingerprint = (fingerprint: string) => {
    if (!fingerprint) {
      return;
    }
    certFingerprint = fingerprint;
    logger.info(`Pinned cert fingerprint: ${certFingerprint}`);
    startupTrace?.record('fingerprint_received', { certFingerprint });
    resolveFingerprint(certFingerprint);
    stopStdoutCollection();
  };

  const onStdoutData = (data: Buffer) => {
    stdoutBuffer += data.toString();
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith(CERT_FINGERPRINT_PREFIX)) {
        recordCertFingerprint(line.slice(CERT_FINGERPRINT_PREFIX.length).trim());
        return;
      }
    }
  };

  gooseProcess.stdout?.on('data', onStdoutData);

  const onStderrData = (data: Buffer) => {
    const lines = data.toString().split('\n');
    appendErrorTail(errorLog, lines);
    if (startupTrace) {
      appendStartupTail(startupTrace.diagnostics.stderrTail, lines);
    }
    for (const line of lines) {
      if (line.trim() && isFatalError(line)) {
        logger.error(`CodeBuddy backend stderr for port ${port} and dir ${workingDir}: ${line}`);
      }
    }
  };

  gooseProcess.stderr?.on('data', onStderrData);

  gooseProcess.on('exit', (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
    logger.info(
      `CodeBuddy backend process exited with code ${code} and signal ${signal} for port ${port} and dir ${workingDir}`
    );
    if (startupTrace) {
      startupTrace.diagnostics.childExitCode = code;
      startupTrace.diagnostics.childExitSignal = signal;
      startupTrace.record('child_exit', { code, signal });
    }
    resolveFingerprint(null);
  });

  gooseProcess.on('error', (error) => {
    spawnFailed = true;
    errorLog.push(error.message);
    logger.error(
      `Failed to start CodeBuddy backend on port ${port} and dir ${workingDir}`,
      error
    );
    startupTrace?.record('spawn_error', { message: error.message, name: error.name });
  });

  const cleanup = async (): Promise<void> => {
    return new Promise<void>((resolve) => {
      if (exited || gooseProcess.killed) {
        resolve();
        return;
      }

      let resolved = false;
      const finish = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      gooseProcess.once('close', finish);

      logger.info('Terminating CodeBuddy backend');
      try {
        if (process.platform === 'win32') {
          if (gooseProcess.pid) {
            spawn('taskkill', ['/pid', gooseProcess.pid.toString(), '/f', '/t']);
          }
        } else {
          gooseProcess.kill('SIGTERM');
        }
      } catch (error) {
        logger.error('Error while terminating CodeBuddy backend process:', error);
      }

      setTimeout(() => {
        if (!exited && !gooseProcess.killed && process.platform !== 'win32') {
          gooseProcess.kill('SIGKILL');
        }
        finish();
      }, 5000);
    });
  };

  const ready = await waitForGooseServeReady(statusUrl, errorLog, () => exited || spawnFailed, {
    healthUrl,
    readinessFetch,
    timeoutMs: getGooseServeReadinessTimeout(isPackaged),
    onEvent: startupTrace?.record,
  });

  const stopOutputCollection = () => {
    stopStdoutCollection();
    gooseProcess.stderr?.off('data', onStderrData);
    gooseProcess.stderr?.resume();
  };

  if (!ready) {
    stopOutputCollection();
    await cleanup();
    const exitDetails = exited ? formatBackendExitDetails(exitCode, exitSignal) : '';
    const stderrDetails = errorLog.length ? ` Stderr: ${errorLog.join('\n')}` : '';
    throw new Error(
      withStartupDiagnosticsPath(
        `CodeBuddy backend did not become ready on ${statusUrl}.${exitDetails}${stderrDetails}`,
        startupDiagnosticsPath
      )
    );
  }

  if (tls) {
    startupTrace?.record('fingerprint_wait_start', { timeoutMs: TLS_FINGERPRINT_TIMEOUT_MS });
    const fingerprint = await waitForFingerprint(fingerprintReady, TLS_FINGERPRINT_TIMEOUT_MS);
    if (!fingerprint) {
      stopOutputCollection();
      await cleanup();
      const exitDetails = exited ? formatBackendExitDetails(exitCode, exitSignal) : '';
      const stderrDetails = errorLog.length ? ` Stderr: ${errorLog.join('\n')}` : '';
      startupTrace?.record('fingerprint_missing', {
        timeoutMs: TLS_FINGERPRINT_TIMEOUT_MS,
        exited,
        exitCode,
        exitSignal,
      });
      throw new Error(
        withStartupDiagnosticsPath(
          `CodeBuddy backend did not emit a TLS certificate fingerprint on ${statusUrl}.${exitDetails}${stderrDetails}`,
          startupDiagnosticsPath
        )
      );
    }
  }

  stopOutputCollection();

  return {
    acpUrl,
    workingDir,
    process: gooseProcess,
    errorLog,
    certFingerprint,
    cleanup,
    hasExited: () => exited,
    getExitDetails: () => ({ code: exitCode, signal: exitSignal }),
    startupDiagnosticsPath,
    getStartupDiagnostics: () => startupTrace?.diagnostics ?? null,
    recordStartupEvent: (name, details) => startupTrace?.record(name, details),
  };
};
