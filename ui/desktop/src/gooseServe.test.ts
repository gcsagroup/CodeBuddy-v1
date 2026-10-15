import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildGooseServeEnv,
  buildLocalServeUrls,
  findGooseBinaryPath,
  formatBackendExitDetails,
  getGooseServeReadinessTimeout,
  isLoopbackTlsReadinessUrl,
  startGooseServe,
} from './gooseServe';

const binaryName = process.platform === 'win32' ? 'goose.exe' : 'goose';
const tempDirs: string[] = [];
const originalCwd = process.cwd();

describe('getGooseServeReadinessTimeout', () => {
  it('allows a slower first startup for an unpackaged development backend', () => {
    expect(getGooseServeReadinessTimeout(false)).toBe(90_000);
    expect(getGooseServeReadinessTimeout(true)).toBe(30_000);
    expect(getGooseServeReadinessTimeout(undefined)).toBe(30_000);
  });
});

describe('formatBackendExitDetails', () => {
  it.each([3221225781, -1073741515])(
    'explains Windows STATUS_DLL_NOT_FOUND for exit code %s',
    (exitCode) => {
      const details = formatBackendExitDetails(exitCode, null, 'win32');

      expect(details).toContain('0xC0000135');
      expect(details).toContain('STATUS_DLL_NOT_FOUND');
      expect(details).toContain('缺少运行时依赖');
      expect(details).toContain('安装包不完整');
      expect(details).not.toContain('VCRUNTIME140');
    }
  );

  it('keeps a generic diagnostic for other exit codes and platforms', () => {
    expect(formatBackendExitDetails(7, null, 'win32')).toBe(
      ' Process exited with code 7 and signal null.'
    );
    expect(formatBackendExitDetails(3221225781, 'SIGTERM', 'linux')).toBe(
      ' Process exited with code 3221225781 and signal SIGTERM.'
    );
  });
});
type ReadinessFetchInit = Parameters<typeof globalThis.fetch>[1];

function makeTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goose-serve-test-'));
  tempDirs.push(tempDir);
  return tempDir;
}

function makeFile(filePath: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '');
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function makeExecutable(filePath: string, contents: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

async function waitForFileLines(filePath: string): Promise<string[]> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf8').trim().split('\n');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

describe('findGooseBinaryPath', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    process.chdir(originalCwd);

    while (tempDirs.length > 0) {
      const tempDir = tempDirs.pop();
      if (tempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('uses GOOSE_BINARY in development builds', () => {
    const tempDir = makeTempDir();
    const overridePath = makeFile(path.join(tempDir, 'override-goose'));
    vi.stubEnv('GOOSE_BINARY', overridePath);

    expect(findGooseBinaryPath({ isPackaged: false })).toBe(overridePath);
  });

  it('prefers the CodeBuddy binary override while retaining the legacy alias', () => {
    const tempDir = makeTempDir();
    const codeBuddyPath = makeFile(path.join(tempDir, 'codebuddy-backend'));
    const legacyPath = makeFile(path.join(tempDir, 'legacy-backend'));
    vi.stubEnv('CODEBUDDY_BINARY', codeBuddyPath);
    vi.stubEnv('GOOSE_BINARY', legacyPath);

    expect(findGooseBinaryPath({ isPackaged: false })).toBe(codeBuddyPath);
  });

  it('rejects GOOSE_BINARY in packaged builds', () => {
    const tempDir = makeTempDir();
    const resourcesPath = path.join(tempDir, 'resources');
    const overridePath = makeFile(path.join(tempDir, 'override-goose'));
    makeFile(path.join(resourcesPath, 'bin', binaryName));
    vi.stubEnv('GOOSE_BINARY', overridePath);

    expect(() => findGooseBinaryPath({ isPackaged: true, resourcesPath })).toThrow(
      'Backend binary overrides are only supported in development builds'
    );
  });

  it('prefers the staged binary over target builds in development builds', () => {
    const tempDir = makeTempDir();
    const desktopDir = path.join(tempDir, 'ui', 'desktop');
    const stagedPath = makeFile(path.join(desktopDir, 'src', 'bin', binaryName));
    const debugPath = makeFile(path.join(tempDir, 'target', 'debug', binaryName));
    const releasePath = makeFile(path.join(tempDir, 'target', 'release', binaryName));
    process.chdir(desktopDir);
    fs.utimesSync(debugPath, new Date(1_000), new Date(1_000));
    fs.utimesSync(releasePath, new Date(1_000), new Date(1_000));
    fs.utimesSync(stagedPath, new Date(2_000), new Date(2_000));

    const resolvedPath = findGooseBinaryPath({ isPackaged: false });
    expect(fs.realpathSync(resolvedPath)).toBe(fs.realpathSync(stagedPath));
    expect(fs.realpathSync(resolvedPath)).not.toBe(fs.realpathSync(releasePath));
    expect(fs.realpathSync(resolvedPath)).not.toBe(fs.realpathSync(debugPath));
  });

  it('uses a newer debug backend when the staged development binary is stale', () => {
    const tempDir = makeTempDir();
    const desktopDir = path.join(tempDir, 'ui', 'desktop');
    const stagedPath = makeFile(path.join(desktopDir, 'src', 'bin', binaryName));
    const debugPath = makeFile(path.join(tempDir, 'target', 'debug', binaryName));
    process.chdir(desktopDir);
    fs.utimesSync(stagedPath, new Date(1_000), new Date(1_000));
    fs.utimesSync(debugPath, new Date(2_000), new Date(2_000));

    expect(fs.realpathSync(findGooseBinaryPath({ isPackaged: false }))).toBe(
      fs.realpathSync(debugPath)
    );
  });

  it('uses the bundled goose binary in packaged builds', () => {
    const tempDir = makeTempDir();
    const resourcesPath = path.join(tempDir, 'resources');
    const bundledPath = makeFile(path.join(resourcesPath, 'bin', binaryName));

    expect(findGooseBinaryPath({ isPackaged: true, resourcesPath })).toBe(bundledPath);
  });
});

describe('buildLocalServeUrls', () => {
  it('builds HTTP and WS URLs', () => {
    expect(buildLocalServeUrls(1234, 'secret', 'http')).toEqual({
      httpBaseUrl: 'http://127.0.0.1:1234',
      statusUrl: 'http://127.0.0.1:1234/status',
      healthUrl: 'http://127.0.0.1:1234/health',
      acpUrl: 'ws://127.0.0.1:1234/acp?token=secret',
      redactedAcpUrl: 'ws://127.0.0.1:1234/acp?token=REDACTED',
    });
  });

  it('builds HTTPS and WSS URLs', () => {
    expect(buildLocalServeUrls(1234, 'secret', 'https')).toEqual({
      httpBaseUrl: 'https://127.0.0.1:1234',
      statusUrl: 'https://127.0.0.1:1234/status',
      healthUrl: 'https://127.0.0.1:1234/health',
      acpUrl: 'wss://127.0.0.1:1234/acp?token=secret',
      redactedAcpUrl: 'wss://127.0.0.1:1234/acp?token=REDACTED',
    });
  });
});

describe('isLoopbackTlsReadinessUrl', () => {
  it('allows only the local self-signed readiness endpoint', () => {
    expect(isLoopbackTlsReadinessUrl('https://127.0.0.1:1234/status')).toBe(true);
    expect(isLoopbackTlsReadinessUrl('https://localhost:1234/status')).toBe(false);
    expect(isLoopbackTlsReadinessUrl('https://example.com/status')).toBe(false);
    expect(isLoopbackTlsReadinessUrl('http://127.0.0.1:1234/status')).toBe(false);
    expect(isLoopbackTlsReadinessUrl('https://127.0.0.1:1234/health')).toBe(false);
  });
});

describe('buildGooseServeEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults desktop backend startup to durable runtime mode', () => {
    const originalRuntimeMode = process.env.CODEPRO_RUNTIME_MODE;
    delete process.env.CODEPRO_RUNTIME_MODE;

    try {
      const env = buildGooseServeEnv('test-secret', process.execPath, {});

      expect(env.CODEPRO_RUNTIME_MODE).toBe('durable');
    } finally {
      if (originalRuntimeMode === undefined) {
        delete process.env.CODEPRO_RUNTIME_MODE;
      } else {
        process.env.CODEPRO_RUNTIME_MODE = originalRuntimeMode;
      }
    }
  });

  it.each(['legacy', 'shadow', 'durable', 'invalid-runtime-mode'])(
    'preserves an explicit parent runtime mode of %s',
    (runtimeMode) => {
      vi.stubEnv('CODEPRO_RUNTIME_MODE', runtimeMode);

      const env = buildGooseServeEnv('test-secret', process.execPath, {});

      expect(env.CODEPRO_RUNTIME_MODE).toBe(runtimeMode);
    }
  );

  it.each(['legacy', 'shadow', 'durable', 'invalid-runtime-mode'])(
    'allows an explicit caller runtime mode of %s to override the parent environment',
    (runtimeMode) => {
      vi.stubEnv('CODEPRO_RUNTIME_MODE', 'shadow');

      const env = buildGooseServeEnv('test-secret', process.execPath, {
        CODEPRO_RUNTIME_MODE: runtimeMode,
      });

      expect(env.CODEPRO_RUNTIME_MODE).toBe(runtimeMode);
    }
  );

  it('preserves existing saved credentials and the explicit goose compatibility source', () => {
    vi.stubEnv('GOOSE_KEYRING_SERVICE', 'inherited-service');
    vi.stubEnv('GOOSE_KEYRING_LEGACY_SERVICE', 'inherited-legacy-service');

    const env = buildGooseServeEnv('test-secret', process.execPath, {
      GOOSE_KEYRING_SERVICE: 'caller-service',
      GOOSE_KEYRING_LEGACY_SERVICE: 'caller-legacy-service',
    });

    expect(env.GOOSE_KEYRING_SERVICE).toBe('codeagentpro');
    expect(env.GOOSE_KEYRING_LEGACY_SERVICE).toBe('goose');
  });
});

describe('startGooseServe', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    process.chdir(originalCwd);

    while (tempDirs.length > 0) {
      const tempDir = tempDirs.pop();
      if (tempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it.skipIf(process.platform === 'win32')('uses the injected readiness fetch', async () => {
    const tempDir = makeTempDir();
    const goosePath = makeExecutable(
      path.join(tempDir, 'goose'),
      '#!/usr/bin/env sh\nwhile true; do sleep 1; done\n'
    );
    vi.stubEnv('GOOSE_BINARY', goosePath);

    const readinessUrls: string[] = [];
    const readinessFetch = vi.fn(async (input: string, _init?: ReadinessFetchInit) => {
      readinessUrls.push(input);
      return new Response(null, { status: 200 });
    });

    const result = await startGooseServe({
      serverSecret: 'test-secret',
      dir: tempDir,
      readinessFetch,
    });

    try {
      expect(readinessFetch).toHaveBeenCalledTimes(1);
      expect(readinessUrls[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/status$/);
    } finally {
      await result.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')('captures the TLS fingerprint from stdout', async () => {
    const tempDir = makeTempDir();
    const goosePath = makeExecutable(
      path.join(tempDir, 'goose'),
      [
        '#!/usr/bin/env sh',
        'printf "GOOSED_CERT_FINGERPRINT=AA:BB:CC\\n"',
        'while true; do sleep 1; done',
        '',
      ].join('\n')
    );
    vi.stubEnv('GOOSE_BINARY', goosePath);

    let fingerprintLogged!: () => void;
    const fingerprintSeen = new Promise<void>((resolve) => {
      fingerprintLogged = resolve;
    });
    const logger = {
      info: vi.fn((message: unknown) => {
        if (String(message).includes('Pinned cert fingerprint')) {
          fingerprintLogged();
        }
      }),
      error: vi.fn(),
    };
    const readinessFetch = vi.fn(async () => {
      await fingerprintSeen;
      return new Response(null, { status: 200 });
    });

    const result = await startGooseServe({
      serverSecret: 'test-secret',
      dir: tempDir,
      logger,
      readinessFetch,
    });

    try {
      expect(result.certFingerprint).toBe('AA:BB:CC');
    } finally {
      await result.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'uses TLS URLs and args when TLS is enabled',
    async () => {
      const tempDir = makeTempDir();
      const argsPath = path.join(tempDir, 'args.txt');
      const goosePath = makeExecutable(
        path.join(tempDir, 'goose'),
        [
          '#!/usr/bin/env sh',
          'printf "%s\\n" "$@" > "$TEST_ARGS_PATH"',
          'printf "GOOSED_CERT_FINGERPRINT=DD:EE:FF\\n"',
          'while true; do sleep 1; done',
          '',
        ].join('\n')
      );
      vi.stubEnv('GOOSE_BINARY', goosePath);

      const readinessUrls: string[] = [];
      const logger = {
        info: vi.fn(),
        error: vi.fn(),
      };
      const readinessFetch = vi.fn(async (input: string, _init?: ReadinessFetchInit) => {
        readinessUrls.push(input);
        return new Response(null, { status: 200 });
      });

      const result = await startGooseServe({
        serverSecret: 'test-secret',
        dir: tempDir,
        tls: true,
        env: {
          TEST_ARGS_PATH: argsPath,
        },
        logger,
        readinessFetch,
      });

      try {
        expect(readinessUrls[0]).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/status$/);
        expect(result.acpUrl).toMatch(/^wss:\/\/127\.0\.0\.1:\d+\/acp\?token=test-secret$/);
        expect(result.certFingerprint).toBe('DD:EE:FF');
        await expect(waitForFileLines(argsPath)).resolves.toContain('--tls');
      } finally {
        await result.cleanup();
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'waits for TLS fingerprint after readiness succeeds',
    async () => {
      const tempDir = makeTempDir();
      const goosePath = makeExecutable(
        path.join(tempDir, 'goose'),
        [
          '#!/usr/bin/env sh',
          'sleep 0.1',
          'printf "GOOSED_CERT_FINGERPRINT=11:22:33\\n"',
          'while true; do sleep 1; done',
          '',
        ].join('\n')
      );
      vi.stubEnv('GOOSE_BINARY', goosePath);

      const readinessFetch = vi.fn(async () => new Response(null, { status: 200 }));

      const result = await startGooseServe({
        serverSecret: 'test-secret',
        dir: tempDir,
        tls: true,
        readinessFetch,
      });

      try {
        expect(readinessFetch).toHaveBeenCalled();
        expect(result.certFingerprint).toBe('11:22:33');
      } finally {
        await result.cleanup();
      }
    }
  );
});
