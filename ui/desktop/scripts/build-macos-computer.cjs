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
  function run(command, args, cwd = root, capture = false) {
    const result = spawnSync(command, args, { cwd, env, shell: false,
      ...(capture ? { encoding: 'utf8' } : { stdio: 'inherit' }) });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`${command} failed with ${result.status ?? result.signal}`);
    return result.stdout?.trim();
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
  if (!fs.existsSync(path.join(native, 'Package.resolved'))) {
    throw new Error('Prepare the pinned Mac FORMS dependencies with swift package --disable-keychain resolve in tools/qwen-computer-use/macos before building.');
  }
  if (test) run('xcrun', ['swift', 'test', '--disable-keychain', '--disable-automatic-resolution',
    '-c', 'release', '--arch', arch === 'arm64' ? 'arm64' : 'x86_64'], native);
  const swiftBuild = ['swift', 'build', '--disable-keychain', '--disable-automatic-resolution',
    '--skip-update', '-c', 'release', '--arch', arch === 'arm64' ? 'arm64' : 'x86_64', '--product', 'qwen-computer-runtime'];
  const nativeBuild = [
    ...swiftBuild,
    '-Xlinker',
    '-sectcreate',
    '-Xlinker',
    '__TEXT',
    '-Xlinker',
    '__info_plist',
    '-Xlinker',
    path.join(native, 'Info.plist'),
  ];
  const swiftOutput = run('xcrun', [...nativeBuild, '--show-bin-path'], native, true);
  run('xcrun', nativeBuild, native);
  fs.copyFileSync(path.join(swiftOutput, 'qwen-computer-runtime'), path.join(output, 'qwen-computer-runtime'));
  for (const name of ['qwen-computer-use', 'qwen-computer-runtime']) {
    verifyMachO(path.join(output, name), arch);
    fs.chmodSync(path.join(output, name), 0o755);
  }
  return output;
}

module.exports = { buildMacComputer };
