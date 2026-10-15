const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  needsBackendBuild,
  needsBackendCopy,
  copyBackendForDevelopment,
  parseEnvironmentBlock,
  resolveBuildJobs,
  resolveBackendBuildEnvironment,
  resolveCargoExecutable,
  formatBuildFailure,
  resolveWindowsBuildEnvironment,
} = require('./ensure-dev-backend.cjs');

test('keeps qualification working directories out of shell argument escaping', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
  );
  const fixtureSource = fs.readFileSync(
    path.join(__dirname, '..', 'tests', 'e2e', 'fixtures.ts'),
    'utf8'
  );

  assert.match(packageJson.scripts['start-gui'], /electron-forge start$/u);
  assert.doesNotMatch(fixtureSource, /pnpm run start-gui --/u);
  assert.match(fixtureSource, /environment\.GOOSE_WORKING_DIR = options\.workingDirectory/u);
});

test('uses one Cargo build job by default and bounds explicit overrides', () => {
  assert.equal(resolveBuildJobs({}), 1);
  assert.equal(resolveBuildJobs({ CODEBUDDY_BUILD_JOBS: '2' }), 2);
  assert.equal(resolveBuildJobs({ CODEBUDDY_BUILD_JOBS: '8' }), 8);
  assert.equal(resolveBuildJobs({ CODEBUDDY_BUILD_JOBS: '0' }), 1);
  assert.equal(resolveBuildJobs({ CODEBUDDY_BUILD_JOBS: '9' }), 1);
  assert.equal(resolveBuildJobs({ CODEBUDDY_BUILD_JOBS: 'not-a-number' }), 1);
});

test('uses memory-safe Cargo defaults without replacing explicit overrides', () => {
  assert.deepEqual(resolveBackendBuildEnvironment({ PATH: 'test-path' }), {
    PATH: 'test-path',
    CARGO_PROFILE_DEV_DEBUG: '0',
    CARGO_INCREMENTAL: '0',
  });

  assert.deepEqual(
    resolveBackendBuildEnvironment({
      CARGO_PROFILE_DEV_DEBUG: '1',
      cargo_incremental: '1',
    }),
    {
      CARGO_PROFILE_DEV_DEBUG: '1',
      cargo_incremental: '1',
    }
  );
});

test('rebuilds when Rust sources are newer than the debug backend', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codepro-backend-'));
  try {
    const source = path.join(root, 'agent.rs');
    const binary = path.join(root, 'goose.exe');
    fs.writeFileSync(binary, 'old');
    fs.writeFileSync(source, 'new');
    fs.utimesSync(binary, new Date(1_000), new Date(1_000));
    fs.utimesSync(source, new Date(2_000), new Date(2_000));

    assert.equal(needsBackendBuild(binary, [source]), true);
    fs.utimesSync(binary, new Date(3_000), new Date(3_000));
    assert.equal(needsBackendBuild(binary, [source]), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('copies a changed backend into the desktop bin directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codepro-backend-'));
  try {
    const built = path.join(root, 'built.exe');
    const bundled = path.join(root, 'bundled.exe');
    fs.writeFileSync(built, 'new backend');
    assert.equal(needsBackendCopy(built, bundled), true);

    fs.copyFileSync(built, bundled);
    assert.equal(needsBackendCopy(built, bundled), false);

    fs.writeFileSync(bundled, 'old backend');
    assert.equal(needsBackendCopy(built, bundled), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('falls back to the built debug backend when the staged binary is locked', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codepro-backend-'));
  try {
    const built = path.join(root, 'built.exe');
    const bundled = path.join(root, 'bin', 'bundled.exe');
    fs.mkdirSync(path.dirname(bundled), { recursive: true });
    fs.writeFileSync(built, 'new backend');
    fs.writeFileSync(bundled, 'running old backend');

    const lockedCopy = () => {
      throw Object.assign(new Error('file is in use'), { code: 'EPERM' });
    };

    assert.equal(copyBackendForDevelopment(built, bundled, lockedCopy), 'built-fallback');
    assert.equal(fs.readFileSync(bundled, 'utf8'), 'running old backend');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('adds the installed Visual Studio libclang directory to the build environment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codepro-libclang-'));
  try {
    const llvmBin = path.join(root, 'VC', 'Tools', 'Llvm', 'x64', 'bin');
    fs.mkdirSync(llvmBin, { recursive: true });
    fs.writeFileSync(path.join(llvmBin, 'libclang.dll'), 'test');

    const environment = resolveWindowsBuildEnvironment({ PATH: 'test-path' }, root);

    assert.equal(environment.LIBCLANG_PATH, llvmBin);
    assert.equal(environment.CXXFLAGS, '/utf-8 /EHsc');
    assert.equal(environment.PATH, 'test-path');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parses the Visual Studio developer environment without pseudo variables', () => {
  const environment = parseEnvironmentBlock(
    '=C:=C:\\repo\r\nPATH=C:\\BuildTools\\CMake\\bin\r\nINCLUDE=C:\\include\r\n'
  );

  assert.deepEqual(environment, {
    PATH: 'C:\\BuildTools\\CMake\\bin',
    INCLUDE: 'C:\\include',
  });
});

test('finds the pinned rustup cargo executable when cargo is missing from PATH', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codepro-rustup-'));
  try {
    const repoRoot = path.join(root, 'repo');
    const rustupHome = path.join(root, 'rustup');
    const cargo = path.join(
      rustupHome,
      'toolchains',
      '1.96.1-x86_64-pc-windows-msvc',
      'bin',
      'cargo.exe'
    );
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.mkdirSync(path.dirname(cargo), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'rust-toolchain.toml'),
      '[toolchain]\nchannel = "1.96.1"\n'
    );
    fs.writeFileSync(cargo, 'test');

    assert.equal(
      resolveCargoExecutable(repoRoot, { PATH: '', RUSTUP_HOME: rustupHome }, 'win32'),
      cargo
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reports the cargo spawn error instead of an unknown exit code', () => {
  const message = formatBuildFailure({
    status: null,
    error: Object.assign(new Error('spawnSync cargo.exe ENOENT'), { code: 'ENOENT' }),
  });

  assert.match(message, /ENOENT/);
  assert.doesNotMatch(message, /退出码 未知/);
});

test('builds and packages a missing standalone MCP, then reuses the unchanged executable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-mcp-build-'));
  try {
    const source = path.join(root, 'tools', 'qwen-computer-use');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'main.go'), 'package main');
    const calls = [];
    const options = {
      platform: 'win32',
      spawnSync: (command, args, options) => {
        calls.push({ command, args, options });
        fs.writeFileSync(args[2], 'built MCP executable');
        return { status: 0 };
      },
    };
    const { ensureStandaloneComputer } = require('./ensure-dev-backend.cjs');
    ensureStandaloneComputer(root, options);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.cwd, source);
    assert.equal(
      fs.readFileSync(
        path.join(root, 'ui', 'desktop', 'src', 'bin', 'qwen-computer-use.exe'),
        'utf8'
      ),
      'built MCP executable'
    );
    ensureStandaloneComputer(root, options);
    assert.equal(calls.length, 1);
    const modified = new Date(Date.now() + 2000);
    fs.utimesSync(path.join(source, 'main.go'), modified, modified);
    assert.throws(
      () => ensureStandaloneComputer(root, { platform: 'win32', spawnSync: () => ({ status: 1 }) }),
      /MCP build failed/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('macOS development keeps the MCP and native helper together and detects Swift changes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-computer-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'tools/qwen-computer-use/macos');
  fs.mkdirSync(source, { recursive: true });
  const swift = path.join(source, 'runtime.swift');
  fs.writeFileSync(swift, 'native source');
  const names = ['qwen-computer-use', 'qwen-computer-runtime'];
  let builds = 0;
  const options = {
    platform: 'darwin',
    arch: 'arm64',
    buildMacComputer: (repo, arch) => {
      assert.equal(repo, root);
      assert.equal(arch, 'arm64');
      builds += 1;
      const compiled = path.join(root, 'compiled');
      fs.mkdirSync(compiled, { recursive: true });
      for (const name of names)
        fs.writeFileSync(path.join(compiled, name), `generation ${builds}: ${name}`);
      return compiled;
    },
  };
  const { ensureStandaloneComputer } = require('./ensure-dev-backend.cjs');
  ensureStandaloneComputer(root, options);
  ensureStandaloneComputer(root, options);
  assert.equal(builds, 1);
  for (const name of names)
    assert.equal(
      fs.readFileSync(path.join(root, 'ui/desktop/src/bin', name), 'utf8'),
      `generation 1: ${name}`
    );
  const changed = new Date(Date.now() + 2000);
  fs.utimesSync(swift, changed, changed);
  ensureStandaloneComputer(root, options);
  assert.equal(builds, 2);
  for (const name of names)
    assert.equal(
      fs.readFileSync(path.join(root, 'ui/desktop/src/bin', name), 'utf8'),
      `generation 2: ${name}`
    );
});
