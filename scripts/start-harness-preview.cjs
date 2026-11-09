#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { defaultWorkspaceRoot, prepareDefaultWorkspace } = require('./default-workspace.cjs');
const { createRotatingLog } = require('../runtime/rotating-log.cjs');
const { locationFile, readDataRoot, assertNoMigration } = require('../runtime/storage-management.cjs');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function previewEnvironment(repoRoot, port, secret, inherited = process.env, dataDirectory) {
  if (dataDirectory !== undefined && (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory))) {
    throw new Error('The preview data directory must be an absolute path');
  }
  if (dataDirectory === undefined && inherited.CODEBUDDY_HOME === undefined) assertNoMigration(locationFile(inherited));
  const requestedHome = dataDirectory ?? inherited.CODEBUDDY_HOME ?? readDataRoot(locationFile(inherited), path.join(os.homedir(), '.CodeBuddy'));
  if (!path.isAbsolute(requestedHome) || path.resolve(requestedHome) === path.parse(path.resolve(requestedHome)).root) {
    throw new Error('The CodeBuddy data directory must be an absolute non-root path');
  }
  const previewHome = path.normalize(requestedHome);
  const workspaceRoot = defaultWorkspaceRoot({ env: { ...inherited, CODEBUDDY_HOME: previewHome } });
  const env = {
    ...inherited,
    CODEBUDDY_HARNESS_PREVIEW: '1',
    CODEBUDDY_HOME: previewHome,
    CODEBUDDY_USER_DATA_DIR: path.join(previewHome, 'state', 'electron-app'),
    CODEBUDDY_PET_DIRECTORY: path.join(previewHome, 'state', 'electron-app', 'pets', 'custom'),
    CODEBUDDY_MIGRATE_LEGACY: 'false',
    CODEBUDDY_DISABLE_PROTOCOL_REGISTRATION: 'true',
    CODEBUDDY_EXTERNAL_BACKEND: '1',
    CODEBUDDY_EXTERNAL_BACKEND_URL: `http://127.0.0.1:${port}`,
    CODEBUDDY_SERVER__SECRET_KEY: secret,
    ENABLE_DEV_UPDATES: 'false',
    CODEBUDDY_WORKSPACE_ROOT: workspaceRoot,
    GOOSE_WORKING_DIR: workspaceRoot,
    GOOSE_TELEMETRY_OFF: '1',
  };
  if (process.platform === 'win32') {
    // Large esbuild transforms share files with its native child. Restricted
    // launch environments can deny child deletion outside the source workspace.
    const profileKey = crypto.createHash('sha256').update(previewHome).digest('hex').slice(0, 16);
    const temporaryDirectory = path.join(repoRoot, '.local', 'preview-temp', profileKey);
    for (const key of Object.keys(env)) {
      if (['TEMP', 'TMP', 'TMPDIR'].includes(key.toUpperCase())) delete env[key];
    }
    Object.assign(env, { TEMP: temporaryDirectory, TMP: temporaryDirectory, TMPDIR: temporaryDirectory });
  }
  // Legacy aliases must not reintroduce an existing profile during startup.
  delete env.GOOSE_PATH_ROOT;
  delete env.GOOSE_DEFAULT_PROVIDER;
  delete env.GOOSE_DEFAULT_MODEL;
  delete env.GOOSE_PREDEFINED_MODELS;
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) {
    if (key.startsWith('CODEAGENTPRO_')) delete env[key];
  }
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = `${path.dirname(process.execPath)}${path.delimiter}${env[pathKey] || ''}`;
  return env;
}

function spawnLogged(command, args, options, logPath, keepStdinOpen = false) {
  const output = createRotatingLog(logPath);
  const child = spawn(command, args, {
    ...options,
    shell: false,
    windowsHide: true,
    // Vite treats EOF on its parent stdin as a shutdown request. Forge must
    // retain an open pipe even when this launcher runs without a terminal.
    stdio: [keepStdinOpen ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  output.on('error', error => {
    console.error('Log output failed:', error.message);
    child.stdout.resume();
    child.stderr.resume();
  });
  const tracked = { child, ended: false, result: null, completion: null };
  tracked.completion = new Promise((resolve) => {
    const finish = (result) => {
      if (tracked.ended) return;
      tracked.ended = true;
      tracked.result = result;
      output.end();
      resolve(result);
    };
    child.once('error', (error) => finish({ code: 1, error: error.message }));
    child.once('close', (code, signal) => finish({ code, signal }));
  });
  return tracked;
}

async function stopOwnedProcess(tracked) {
  if (!tracked || tracked.ended || !tracked.child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(tracked.child.pid), '/f', '/t'], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore',
    });
    killer.on('error', () => tracked.child.kill());
  } else {
    tracked.child.kill('SIGTERM');
  }
  await Promise.race([tracked.completion, delay(5000)]);
  if (!tracked.ended) tracked.child.kill('SIGKILL');
}

async function waitForBackend(tracked, url, secret, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastReadinessResult = 'No response';
  while (Date.now() < deadline) {
    if (tracked.ended) {
      throw new Error(`Harness bridge exited before readiness (${JSON.stringify(tracked.result)})`);
    }
    try {
      const response = await fetch(`${url}/status`, {
        headers: { 'X-Secret-Key': secret },
        signal: AbortSignal.timeout(1000),
      });
      lastReadinessResult = `Status HTTP ${response.status}`;
      if (response.ok) {
        const status = await response.json().catch(() => ({}));
        const auth = await fetch(`${url}/acp?token=${encodeURIComponent(secret)}`, {
          signal: AbortSignal.timeout(1000),
        });
        lastReadinessResult = `ACP HTTP ${auth.status}`;
        if (auth.status === 406) return status;
        if (auth.status === 401 || auth.status === 403) throw new Error('Harness bridge rejected the preview secret');
      }
    } catch (error) {
      if (error.message === 'Harness bridge rejected the preview secret') throw error;
      // Keep credentials out of diagnostics, including URLs in transport errors.
      lastReadinessResult = `${error.name || 'Error'}${error.cause?.code ? ` (${error.cause.code})` : ''}`;
    }
    await delay(100);
  }
  throw new Error(`Harness bridge readiness timed out at ${url}: ${lastReadinessResult}`);
}

function defaultCommands(repoRoot) {
  const sdkRoot = path.join(repoRoot, 'ui', 'sdk');
  const desktopRoot = path.join(repoRoot, 'ui', 'desktop');
  const tsc = require.resolve('typescript/bin/tsc', { paths: [sdkRoot] });
  const forgePackagePath = require.resolve('@electron-forge/cli/package.json', { paths: [desktopRoot] });
  const forgePackage = JSON.parse(fs.readFileSync(forgePackagePath, 'utf8'));
  const forgeBin = typeof forgePackage.bin === 'string' ? forgePackage.bin : forgePackage.bin['electron-forge'];
  return {
    prepare: [
      ...(process.platform === 'darwin' ? [{ args: [path.join(repoRoot, 'scripts/prepare-harness-macos-tools.cjs')], cwd: repoRoot }] : []),
      { args: [tsc, '--project', path.join(sdkRoot, 'tsconfig.json')], cwd: sdkRoot },
      { args: [path.join(desktopRoot, 'scripts', 'i18n-compile.js')], cwd: desktopRoot },
    ],
    desktop: { args: [path.resolve(path.dirname(forgePackagePath), forgeBin), 'start'], cwd: desktopRoot },
  };
}

async function checkPreviewArtifacts(repoRoot) {
  const failures = [];
  const checked = [];
  try {
    const { builtinArtifacts, verifiedBinary } = await import(pathToFileURL(path.join(repoRoot, 'runtime', 'builtin-artifacts.mjs')).href);
    const artifacts = await builtinArtifacts();
    for (const artifact of Object.values(artifacts)) {
      const file = path.join(repoRoot, 'runtime', 'tools', 'bin', artifact.file);
      try {
        await verifiedBinary(artifact);
        checked.push(file);
      } catch (error) {
        failures.push(`${file}\n  ${error.message}\n  Expected: ${artifact.bytes} bytes; SHA256 ${artifact.sha256}`);
      }
    }
  } catch (error) {
    failures.push(`${path.join(repoRoot, 'runtime', 'builtin-artifacts.mjs')}\n  ${error.message}`);
  }
  if (failures.length) {
    const preparation = process.platform === 'darwin'
      ? '请按 docs/macos.zh-CN.md 准备本机架构的工具及 artifacts.json；原生工具准备完成后仍须通过上述校验。'
      : '请按 README.md 的“Windows 构建”说明准备独立 MCP 工具：先备份旧文件，再从与当前源码匹配的已核验载荷恢复上述文件；也可按文档离线构建并核对来源和产物登记。';
    throw new Error([
      '预览工具检查失败（Preview tool check failed），尚未启动后端或桌面。',
      ...failures,
      'Git 不同步 runtime/tools/bin 中的工具；只拉源码可能保留旧文件。',
      preparation,
      '不要仅修改大小或哈希来绕过校验。本检查不会自动下载、安装或替换工具。',
      `准备完成后重新运行预览入口。说明：${path.join(repoRoot, 'README.md')}`,
    ].join('\n'));
  }
  return { status: 'passed', files: checked };
}

async function startPreview(options = {}) {
  const repoRoot = options.repoRoot || path.resolve(__dirname, '..');
  const port = await reservePort();
  const secret = crypto.randomBytes(32).toString('hex');
  const env = previewEnvironment(repoRoot, port, secret, options.env, options.dataDirectory);
  // Forge also checks Git before opening Electron. Prepare the shared child
  // environment once so the desktop and Harness do not inherit different PATHs.
  const { ensureGitEnvironment } = await import('../runtime/git-environment.mjs');
  await ensureGitEnvironment(env);
  const logRoot = path.join(env.CODEBUDDY_HOME, 'logs', 'preview');
  fs.mkdirSync(logRoot, { recursive: true });
  fs.mkdirSync(env.CODEBUDDY_USER_DATA_DIR, { recursive: true });
  if (process.platform === 'win32') fs.mkdirSync(env.TEMP, { recursive: true });
  fs.mkdirSync(path.join(env.CODEBUDDY_HOME, 'profiles', 'local', 'state', 'electron'), { recursive: true });
  const receiptPath = path.join(logRoot, 'launch.json');
  const { acquireProfileLock } = await import('../runtime/profile-lock.mjs');
  // A launcher lease covers preparation as well as the backend lifetime. Probe
  // the backend lease too, so older launchers cannot have their receipt erased.
  let launchLease;
  try {
    launchLease = await acquireProfileLock(logRoot);
    const backendLease = await acquireProfileLock(path.join(env.CODEBUDDY_HOME, 'backend'));
    backendLease.close();
  } catch (error) {
    launchLease?.close();
    if (error.code === 'PROFILE_IN_USE') throw new Error('此配置已有运行中的后台。请等待任务完成并关闭旧窗口，再重新启动以加载修改。原启动记录已保留。');
    throw error;
  }
  const receipt = {
    status: 'starting', startedAt: new Date().toISOString(), repoRoot,
    launcherPid: process.pid, runtimePid: null, desktopPid: null,
    backendUrl: env.CODEBUDDY_EXTERNAL_BACKEND_URL,
    dataDirectory: env.CODEBUDDY_HOME,
    ...(process.platform === 'win32' ? { temporaryDirectory: env.TEMP } : {}),
    runtimeLog: path.join(logRoot, 'runtime.log'),
    desktopLog: path.join(logRoot, 'electron.log'),
  };
  const saveReceipt = () => fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const owned = [];
  let resolveStop;
  const interrupted = new Promise((resolve) => { resolveStop = resolve; });
  const onSignal = () => resolveStop({ interrupted: true });
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    saveReceipt();
    // Mac's existing preparation builds its local artifacts first. Windows
    // artifacts are supplied separately and must pass before SDK preparation.
    if (process.platform !== 'darwin') {
      if (process.platform === 'win32' && process.argv.includes('--skip-optional-tool-check')) {
        receipt.artifactCheck = { status: 'skipped', reason: 'Explicit development launch without optional Windows MCP binaries', files: ['codebuddy-tools.exe', 'qwen-computer-use.exe'] };
        console.warn('Optional Windows MCP artifact check skipped for this launch. Missing tools remain unavailable.');
      } else {
        receipt.artifactCheck = await checkPreviewArtifacts(repoRoot);
      }
      saveReceipt();
    }
    const commands = options.commands || defaultCommands(repoRoot);
    const workspaceRoot = prepareDefaultWorkspace(env.CODEBUDDY_WORKSPACE_ROOT);
    env.CODEBUDDY_WORKSPACE_ROOT = workspaceRoot;
    env.GOOSE_WORKING_DIR = workspaceRoot;
    receipt.defaultWorkspaceRoot = workspaceRoot;
    saveReceipt();
    for (const command of commands.prepare) {
      const prepare = spawnLogged(process.execPath, command.args, { cwd: command.cwd, env }, path.join(logRoot, 'prepare.log'));
      owned.push(prepare);
      const result = await Promise.race([prepare.completion, interrupted]);
      if (result.interrupted) return 0;
      if (result.code !== 0) throw new Error(`Preview preparation failed. See ${path.join(logRoot, 'prepare.log')}`);
    }
    if (process.platform === 'darwin') {
      receipt.artifactCheck = await checkPreviewArtifacts(repoRoot);
      saveReceipt();
    }
    const runtime = spawnLogged(process.execPath, [
      options.serverPath || path.join(repoRoot, 'runtime', 'server.mjs'),
      '--port', String(port), '--host', '127.0.0.1',
      '--data-dir', path.join(env.CODEBUDDY_HOME, 'backend'),
    ], { cwd: repoRoot, env }, receipt.runtimeLog);
    owned.push(runtime);
    receipt.runtimePid = runtime.child.pid || null;
    saveReceipt();
    const backendStatus = await Promise.race([
      waitForBackend(runtime, receipt.backendUrl, secret, options.readinessTimeoutMs),
      interrupted,
    ]);
    if (backendStatus.interrupted) return 0;
    receipt.runtimeIdentity = backendStatus.runtime;
    if (backendStatus.modelConfigured !== true) {
      env.CODEBUDDY_PREVIEW_INITIAL_ROUTE = '/configure-providers';
    } else {
      delete env.CODEBUDDY_PREVIEW_INITIAL_ROUTE;
    }
    const desktop = spawnLogged(process.execPath, commands.desktop.args, { cwd: commands.desktop.cwd, env }, receipt.desktopLog, true);
    owned.push(desktop);
    receipt.desktopPid = desktop.child.pid || null;
    receipt.status = 'running';
    saveReceipt();
    console.log(`Harness bridge is ready; Electron is starting. Launch receipt: ${receiptPath}`);
    options.onReady?.({ ...receipt });
    const outcome = await Promise.race([
      desktop.completion.then((result) => ({ source: 'desktop', ...result })),
      runtime.completion.then((result) => ({ source: 'runtime', ...result })),
      interrupted,
    ]);
    if (outcome.interrupted) return 0;
    if (outcome.source === 'runtime') throw new Error(`Harness bridge exited while the desktop was open. See ${receipt.runtimeLog}`);
    receipt.desktopExitCode = outcome.code;
    if (outcome.code !== 0) {
      receipt.status = 'failed';
      receipt.error = `Electron launcher exited with code ${outcome.code}. See ${receipt.desktopLog}`;
    }
    return outcome.code ?? 1;
  } catch (error) {
    receipt.status = 'failed';
    receipt.error = error.message;
    throw error;
  } finally {
    for (const tracked of owned.reverse()) await stopOwnedProcess(tracked);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (receipt.status !== 'failed') receipt.status = 'stopped';
    receipt.stoppedAt = new Date().toISOString();
    try { saveReceipt(); } finally { launchLease.close(); }
  }
}

module.exports = { previewEnvironment, startPreview, checkPreviewArtifacts };

if (require.main === module) {
  if (Number(process.versions.node.split('.')[0]) < 24) {
    console.error('The Harness preview requires Node.js 24 or later. Run this launcher with the project Node 24 runtime.');
    process.exitCode = 1;
  } else {
    startPreview().then((code) => { process.exitCode = code; }).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
