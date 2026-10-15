const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function latestMtimeMs(entryPath) {
  if (!fs.existsSync(entryPath)) {
    return 0;
  }

  const stats = fs.statSync(entryPath);
  if (!stats.isDirectory()) {
    return stats.mtimeMs;
  }

  let latest = stats.mtimeMs;
  for (const entry of fs.readdirSync(entryPath, { withFileTypes: true })) {
    latest = Math.max(latest, latestMtimeMs(path.join(entryPath, entry.name)));
  }
  return latest;
}

function needsBackendBuild(binaryPath, sourcePaths) {
  if (!fs.existsSync(binaryPath)) {
    return true;
  }

  const binaryMtime = fs.statSync(binaryPath).mtimeMs;
  return sourcePaths.some((sourcePath) => latestMtimeMs(sourcePath) > binaryMtime);
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function needsBackendCopy(builtPath, bundledPath) {
  if (!fs.existsSync(bundledPath)) {
    return true;
  }

  const builtStats = fs.statSync(builtPath);
  const bundledStats = fs.statSync(bundledPath);
  return builtStats.size !== bundledStats.size || sha256(builtPath) !== sha256(bundledPath);
}

function copyBackendForDevelopment(builtPath, bundledPath, copyFileSync = fs.copyFileSync) {
  if (!needsBackendCopy(builtPath, bundledPath)) {
    return 'current';
  }

  fs.mkdirSync(path.dirname(bundledPath), { recursive: true });
  try {
    copyFileSync(builtPath, bundledPath);
    return 'copied';
  } catch (error) {
    if (error && (error.code === 'EBUSY' || error.code === 'EPERM')) {
      return 'built-fallback';
    }
    throw error;
  }
}

function environmentValue(environment, name) {
  const entry = Object.entries(environment).find(
    ([key]) => key.toLowerCase() === name.toLowerCase()
  );
  return entry?.[1];
}

function resolveBuildJobs(environment = process.env) {
  const requested = environmentValue(environment, 'CODEBUDDY_BUILD_JOBS');
  if (!requested) {
    return 1;
  }
  const jobs = Number(requested);
  return Number.isInteger(jobs) && jobs >= 1 && jobs <= 8 ? jobs : 1;
}

function resolveBackendBuildEnvironment(environment = process.env) {
  const resolved = { ...environment };
  if (!environmentValue(resolved, 'CARGO_PROFILE_DEV_DEBUG')) {
    resolved.CARGO_PROFILE_DEV_DEBUG = '0';
  }
  if (!environmentValue(resolved, 'CARGO_INCREMENTAL')) {
    resolved.CARGO_INCREMENTAL = '0';
  }
  return resolved;
}

function executableOnPath(executable, environment, platform) {
  const searchPath = environmentValue(environment, 'PATH');
  if (!searchPath) {
    return undefined;
  }
  const delimiter = platform === 'win32' ? ';' : ':';
  for (const directory of searchPath.split(delimiter).filter(Boolean)) {
    const candidate = path.join(directory.replace(/^"|"$/g, ''), executable);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function pinnedRustChannel(repoRoot) {
  const toolchainFile = path.join(repoRoot, 'rust-toolchain.toml');
  if (!fs.existsSync(toolchainFile)) {
    return undefined;
  }
  return fs.readFileSync(toolchainFile, 'utf8').match(/^\s*channel\s*=\s*["']([^"']+)["']/m)?.[1];
}

function resolveCargoExecutable(repoRoot, environment = process.env, platform = process.platform) {
  const executable = platform === 'win32' ? 'cargo.exe' : 'cargo';
  const fromPath = executableOnPath(executable, environment, platform);
  if (fromPath || platform !== 'win32') {
    return fromPath || executable;
  }

  const userProfile = environmentValue(environment, 'USERPROFILE');
  const cargoHome =
    environmentValue(environment, 'CARGO_HOME') ||
    (userProfile ? path.join(userProfile, '.cargo') : undefined);
  const cargoShim = cargoHome ? path.join(cargoHome, 'bin', executable) : undefined;
  if (cargoShim && fs.existsSync(cargoShim)) {
    return cargoShim;
  }

  const rustupHome =
    environmentValue(environment, 'RUSTUP_HOME') ||
    (userProfile ? path.join(userProfile, '.rustup') : undefined);
  const channel = pinnedRustChannel(repoRoot);
  const toolchainsRoot = rustupHome ? path.join(rustupHome, 'toolchains') : undefined;
  if (channel && toolchainsRoot && fs.existsSync(toolchainsRoot)) {
    const toolchains = fs
      .readdirSync(toolchainsRoot, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && (entry.name === channel || entry.name.startsWith(`${channel}-`))
      )
      .map((entry) => path.join(toolchainsRoot, entry.name, 'bin', executable));
    const pinnedCargo = toolchains.find((candidate) => fs.existsSync(candidate));
    if (pinnedCargo) {
      return pinnedCargo;
    }
  }

  return executable;
}

function formatBuildFailure(result) {
  if (result.error) {
    const code = result.error.code ? `${result.error.code}: ` : '';
    return `CodeBuddy 开发后端构建无法启动（${code}${result.error.message}）`;
  }
  if (result.signal) {
    return `CodeBuddy 开发后端构建被信号 ${result.signal} 终止`;
  }
  return `CodeBuddy 开发后端构建失败（退出码 ${result.status}）`;
}

function discoverVisualStudioPath(environment) {
  const programFilesX86 = environment['ProgramFiles(x86)'];
  if (!programFilesX86) {
    return undefined;
  }

  const vswhere = path.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!fs.existsSync(vswhere)) {
    return undefined;
  }

  const result = spawnSync(
    vswhere,
    [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath',
    ],
    { encoding: 'utf8', windowsHide: true }
  );
  const installationPath = result.stdout?.trim();
  if (result.error) {
    throw new Error(`无法运行 Visual Studio 工具发现：${result.error.message}`);
  }
  return result.status === 0 && installationPath ? installationPath : undefined;
}

function parseEnvironmentBlock(output) {
  const environment = {};
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator > 0) {
      environment[line.slice(0, separator)] = line.slice(separator + 1);
    }
  }
  return environment;
}

function importVisualStudioEnvironment(baseEnvironment, visualStudioPath) {
  if (!visualStudioPath) {
    return { ...baseEnvironment };
  }

  const vsDevCmd = path.join(visualStudioPath, 'Common7', 'Tools', 'VsDevCmd.bat');
  if (!fs.existsSync(vsDevCmd)) {
    return { ...baseEnvironment };
  }

  const result = spawnSync(
    'cmd.exe',
    ['/d', '/c', 'call', vsDevCmd, '-no_logo', '-arch=x64', '-host_arch=x64', '>nul', '&&', 'set'],
    {
      encoding: 'utf8',
      env: baseEnvironment,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    }
  );
  if (result.status !== 0) {
    throw new Error('无法导入 Visual Studio C++ 开发环境。');
  }
  return { ...baseEnvironment, ...parseEnvironmentBlock(result.stdout) };
}

function resolveWindowsBuildEnvironment(baseEnvironment = process.env, installationPath) {
  const visualStudioPath = installationPath || discoverVisualStudioPath(baseEnvironment);
  const environment = importVisualStudioEnvironment(baseEnvironment, visualStudioPath);
  // VsDevCmd sets up MSVC, but not every VS installation exposes its bundled
  // CMake on PATH. Keep explicit CMAKE and PATH installations authoritative.
  if (
    visualStudioPath &&
    !environmentValue(environment, 'CMAKE') &&
    !executableOnPath('cmake.exe', environment, 'win32')
  ) {
    const bundledCmake = path.join(
      visualStudioPath,
      'Common7',
      'IDE',
      'CommonExtensions',
      'Microsoft',
      'CMake',
      'CMake',
      'bin',
      'cmake.exe'
    );
    if (fs.existsSync(bundledCmake)) {
      environment.CMAKE = bundledCmake;
    }
  }
  const configuredLibclang = environment.LIBCLANG_PATH;
  if (!configuredLibclang || !fs.existsSync(path.join(configuredLibclang, 'libclang.dll'))) {
    const candidates = visualStudioPath
      ? [
          path.join(visualStudioPath, 'VC', 'Tools', 'Llvm', 'x64', 'bin'),
          path.join(visualStudioPath, 'VC', 'Tools', 'Llvm', 'bin'),
        ]
      : [];
    const llvmBin = candidates.find((candidate) =>
      fs.existsSync(path.join(candidate, 'libclang.dll'))
    );
    if (llvmBin) {
      environment.LIBCLANG_PATH = llvmBin;
    }
  }

  environment.CXXFLAGS ||= '/utf-8 /EHsc';
  return environment;
}

function ensureStandaloneComputer(repoRoot, options = {}) {
  const platform = options.platform || process.platform;
  if (platform === 'darwin') {
    const names = ['qwen-computer-use', 'qwen-computer-runtime'];
    const source = path.join(repoRoot, 'tools', 'qwen-computer-use');
    const debug = path.join(repoRoot, 'target', 'debug');
    const bundle = path.join(repoRoot, 'ui', 'desktop', 'src', 'bin');
    if (names.some((name) => needsBackendBuild(path.join(debug, name), [source]))) {
      const build =
        options.buildMacComputer || require('./build-macos-computer.cjs').buildMacComputer;
      const compiled = build(repoRoot, options.arch || process.arch);
      fs.mkdirSync(debug, { recursive: true });
      for (const name of names) {
        fs.copyFileSync(path.join(compiled, name), path.join(debug, name));
        fs.chmodSync(path.join(debug, name), 0o755);
      }
    }
    for (const name of names) {
      if (
        copyBackendForDevelopment(path.join(debug, name), path.join(bundle, name)) ===
        'built-fallback'
      )
        throw new Error('Close the old desktop app before updating its computer runtime.');
    }
    return;
  }
  if (platform !== 'win32') return;
  const built = path.join(repoRoot, 'target', 'debug', 'qwen-computer-use.exe');
  const bundled = path.join(repoRoot, 'ui', 'desktop', 'src', 'bin', 'qwen-computer-use.exe');
  const source = path.join(repoRoot, 'tools', 'qwen-computer-use');
  const sources = fs
    .readdirSync(source)
    .filter((name) => /\.(go|ps1|cs)$/.test(name) || name === 'go.mod')
    .map((name) => path.join(source, name));
  if (needsBackendBuild(built, sources)) {
    fs.mkdirSync(path.dirname(built), { recursive: true });
    const result = (options.spawnSync || spawnSync)(
      process.env.CODEBUDDY_GO_EXECUTABLE || 'go',
      ['build', '-o', built, '.'],
      {
        cwd: source,
        env: process.env,
        stdio: 'inherit',
        windowsHide: true,
      }
    );
    if (result.status !== 0)
      throw new Error('Computer MCP build failed. Install Go or set CODEBUDDY_GO_EXECUTABLE.');
  }
  if (copyBackendForDevelopment(built, bundled) === 'built-fallback') {
    throw new Error('Close the old desktop app before updating its computer MCP executable.');
  }
}

function ensureDevBackend() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  if (process.platform === 'darwin') {
    // The published node-pty helper can lack its execute bit. Reuse the same
    // architecture and permission check used before signing packaged apps.
    const { preparePty } = require('./macos-package.cjs');
    const ptyRoot = path.dirname(require.resolve('node-pty/package.json'));
    preparePty(path.dirname(path.dirname(ptyRoot)), process.arch);
  }
  const binaryName = process.platform === 'win32' ? 'goose.exe' : 'goose';
  const builtPath = path.join(repoRoot, 'target', 'debug', binaryName);
  const bundledPath = path.join(repoRoot, 'ui', 'desktop', 'src', 'bin', binaryName);
  const sourcePaths = [
    path.join(repoRoot, 'Cargo.toml'),
    path.join(repoRoot, 'Cargo.lock'),
    path.join(repoRoot, 'rust-toolchain.toml'),
    path.join(repoRoot, 'crates', 'goose', 'Cargo.toml'),
    path.join(repoRoot, 'crates', 'goose', 'src'),
    path.join(repoRoot, 'crates', 'goose-cli', 'Cargo.toml'),
    path.join(repoRoot, 'crates', 'goose-cli', 'src'),
    path.join(repoRoot, 'crates', 'goose-provider-types', 'Cargo.toml'),
    path.join(repoRoot, 'crates', 'goose-provider-types', 'src'),
    path.join(repoRoot, 'crates', 'goose-providers', 'Cargo.toml'),
    path.join(repoRoot, 'crates', 'goose-providers', 'src'),
  ];

  if (needsBackendBuild(builtPath, sourcePaths)) {
    console.log('Rust 源码有更新，正在低内存构建 CodeBuddy 开发后端...');
    const platformEnvironment =
      process.platform === 'win32' ? resolveWindowsBuildEnvironment() : process.env;
    const environment = resolveBackendBuildEnvironment(platformEnvironment);
    const cargoExecutable = resolveCargoExecutable(repoRoot, environment);
    const jobs = resolveBuildJobs(environment);
    const result = spawnSync(
      cargoExecutable,
      ['build', '-p', 'goose-cli', '--bin', 'goose', '--jobs', String(jobs)],
      {
        cwd: repoRoot,
        env: environment,
        stdio: 'inherit',
        windowsHide: true,
      }
    );
    if (result.status !== 0) {
      throw new Error(formatBuildFailure(result));
    }
  }

  ensureStandaloneComputer(repoRoot);
  const copyResult = copyBackendForDevelopment(builtPath, bundledPath);
  if (copyResult === 'copied') {
    console.log(`已同步最新开发后端：${bundledPath}`);
  } else if (copyResult === 'built-fallback') {
    console.warn(
      `桌面旧后端正在使用，未覆盖 ${bundledPath}；本次开发启动将直接使用新构建：${builtPath}`
    );
  } else {
    console.log('CodeBuddy 开发后端已是最新版本。');
  }
}

module.exports = {
  latestMtimeMs,
  needsBackendBuild,
  needsBackendCopy,
  copyBackendForDevelopment,
  parseEnvironmentBlock,
  resolveBuildJobs,
  resolveBackendBuildEnvironment,
  resolveCargoExecutable,
  formatBuildFailure,
  resolveWindowsBuildEnvironment,
  ensureDevBackend,
  ensureStandaloneComputer,
};

if (require.main === module) {
  try {
    ensureDevBackend();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
