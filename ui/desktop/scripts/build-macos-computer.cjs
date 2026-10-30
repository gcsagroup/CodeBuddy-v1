const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verifyMachO, targetFor } = require('./macos-package.cjs');

function buildMacComputer(repo, arch, { test = false } = {}) {
  targetFor(arch);
  if (process.platform !== 'darwin' || process.arch !== arch)
    throw new Error(`Build the computer runtime on a native ${arch} Mac.`);
  const root = path.join(repo, 'tools/qwen-computer-use');
  const native = path.join(root, 'macos');
  const parent = path.join(repo, 'target/codebuddy-package');
  fs.mkdirSync(parent, { recursive: true });
  const output = fs.mkdtempSync(path.join(parent, `computer-${arch}-`));
  const env = {
    ...process.env,
    CGO_ENABLED: '0',
    GOOS: 'darwin',
    GOARCH: arch === 'arm64' ? 'arm64' : 'amd64',
    GOTOOLCHAIN: 'local',
    GOPROXY: 'off',
  };
  function run(command, args, cwd = root) {
    const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: false });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`${command} failed with ${result.status ?? result.signal}`);
  }
  const go = process.env.CODEBUDDY_GO_EXECUTABLE || 'go';
  if (test) run(go, ['test', './...']);
  const triple = `${arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos14.0`;
  const common = [
    'swiftc',
    '-parse-as-library',
    '-O',
    '-target',
    triple,
    path.join(native, 'RuntimeContract.swift'),
    path.join(native, 'NativeInput.swift'),
  ];
  if (test) {
    const checks = path.join(output, 'contract-tests');
    run('xcrun', [...common, path.join(native, 'contract-tests.swift'), '-o', checks]);
    run(checks, []);
  }
  run(go, ['build', '-trimpath', '-o', path.join(output, 'qwen-computer-use'), '.']);
  run('xcrun', [
    ...common,
    path.join(native, 'runtime.swift'),
    '-o',
    path.join(output, 'qwen-computer-runtime'),
    '-Xlinker',
    '-sectcreate',
    '-Xlinker',
    '__TEXT',
    '-Xlinker',
    '__info_plist',
    '-Xlinker',
    path.join(native, 'Info.plist'),
  ]);
  for (const name of ['qwen-computer-use', 'qwen-computer-runtime']) {
    verifyMachO(path.join(output, name), arch);
    fs.chmodSync(path.join(output, name), 0o755);
  }
  return output;
}

module.exports = { buildMacComputer };
