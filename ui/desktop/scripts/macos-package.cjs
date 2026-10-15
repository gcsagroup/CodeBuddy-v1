const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const targets = { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' };
const shims = ['node', 'npx', 'node-setup-common.sh', 'uvx', 'jbang'];
const computerBinaries = ['qwen-computer-use', 'qwen-computer-runtime'];

function targetFor(arch) {
  if (!targets[arch]) throw new Error(`Unsupported macOS architecture: ${arch}; use arm64 or x64`);
  return targets[arch];
}

function verifyMachO(file, arch) {
  targetFor(arch);
  const header = Buffer.alloc(32);
  const fd = fs.openSync(file, 'r');
  let size;
  try {
    size = fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  const cpu = arch === 'arm64' ? 0x0100000c : 0x01000007;
  if (size < 32 || header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== cpu) {
    throw new Error(`Expected a thin ${arch} Mach-O binary: ${file}`);
  }
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, count));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function stageBackend(
  desktopRoot,
  backend,
  arch,
  source,
  computerDirectory = path.dirname(backend)
) {
  verifyMachO(backend, arch);
  for (const name of computerBinaries) verifyMachO(path.join(computerDirectory, name), arch);
  const stageRoot = path.resolve(desktopRoot, '../../target/codebuddy-package');
  fs.mkdirSync(stageRoot, { recursive: true });
  // A fresh stage avoids modifying the development backend or mixing architectures.
  const stage = fs.mkdtempSync(path.join(stageRoot, `macos-${arch}-`));
  const resourceDirectory = path.join(stage, 'bin');
  fs.mkdirSync(resourceDirectory);
  const staged = path.join(resourceDirectory, 'goose');
  fs.copyFileSync(backend, staged);
  fs.chmodSync(staged, 0o755);
  const computerHashes = {};
  for (const name of computerBinaries) {
    const destination = path.join(resourceDirectory, name);
    fs.copyFileSync(path.join(computerDirectory, name), destination);
    fs.chmodSync(destination, 0o755);
    computerHashes[name] = sha256(destination);
  }
  for (const name of shims) {
    const destination = path.join(resourceDirectory, name);
    // Windows checkouts can contain CRLF; shell resources must remain executable on macOS.
    fs.writeFileSync(
      destination,
      fs.readFileSync(path.join(desktopRoot, 'src/bin', name), 'utf8').replace(/\r\n/g, '\n')
    );
    fs.chmodSync(destination, 0o755);
  }
  const manifest = {
    schemaVersion: 1,
    profile: 'release',
    target: targetFor(arch),
    arch,
    resourceDirectory,
    backendSha256: sha256(staged),
    computerHashes,
    source,
  };
  const manifestPath = path.join(stage, 'backend-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { resourceDirectory, manifestPath };
}

function verifyStage(desktopRoot, resourceDirectory, manifestPath, arch) {
  if (!resourceDirectory || !manifestPath) {
    throw new Error(
      'macOS package/make requires pnpm run bundle:mac (verified Release backend stage).'
    );
  }
  const root = fs.realpathSync(path.resolve(desktopRoot, '../../target/codebuddy-package'));
  for (const item of [resourceDirectory, manifestPath]) {
    const relative = path.relative(root, fs.realpathSync(item));
    if (
      !relative ||
      relative.startsWith(`..${path.sep}`) ||
      relative === '..' ||
      path.isAbsolute(relative)
    ) {
      throw new Error('macOS backend stage must stay inside target/codebuddy-package');
    }
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const backend = path.join(resourceDirectory, 'goose');
  verifyMachO(backend, arch);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.profile !== 'release' ||
    manifest.target !== targetFor(arch) ||
    manifest.arch !== arch ||
    path.resolve(manifest.resourceDirectory) !== path.resolve(resourceDirectory) ||
    manifest.backendSha256 !== sha256(backend)
  ) {
    throw new Error('macOS backend manifest does not match the staged Release backend');
  }
  for (const name of computerBinaries) {
    const file = path.join(resourceDirectory, name);
    verifyMachO(file, arch);
    if (manifest.computerHashes?.[name] !== sha256(file))
      throw new Error(`macOS computer runtime manifest mismatch: ${name}`);
  }
  return manifest;
}

function stagePty(buildPath, ptyRoot = path.dirname(require.resolve('node-pty/package.json'))) {
  // Vite bundles JavaScript and excludes node_modules. Copy the native runtime
  // from its resolved (possibly workspace-hoisted) location before Forge rebuilds it.
  const headersRoot = path.dirname(
    require.resolve('node-addon-api/package.json', { paths: [ptyRoot] })
  );
  for (const [name, source] of [
    ['node-pty', ptyRoot],
    ['node-addon-api', headersRoot],
  ]) {
    fs.cpSync(source, path.join(buildPath, 'node_modules', name), {
      recursive: true,
      dereference: true,
      force: false,
      errorOnExist: true,
    });
  }
}

function preparePty(buildPath, arch, fixPermissions = true) {
  const root = path.join(buildPath, 'node_modules/node-pty');
  // Same priority as node-pty's native loader; Forge has already rebuilt for Electron.
  const nativeDir = ['build/Release', 'build/Debug', `prebuilds/darwin-${arch}`]
    .map((dir) => path.join(root, dir))
    .find((dir) => fs.existsSync(path.join(dir, 'pty.node')));
  if (!nativeDir) throw new Error('Missing macOS node-pty native module after Electron rebuild');
  verifyMachO(path.join(nativeDir, 'pty.node'), arch);
  const helper = path.join(nativeDir, 'spawn-helper');
  verifyMachO(helper, arch);
  // pnpm/npm tarballs have shipped this helper without its execute bit.
  // Fix the staged copy before ASAR creation and signing, never the installed app.
  if (fixPermissions) fs.chmodSync(helper, 0o755);
  if (process.platform !== 'win32') fs.accessSync(helper, fs.constants.X_OK);
}

function verifyBundle(app, arch, manifestPath) {
  const resources = path.join(app, 'Contents/Resources');
  const backend = path.join(resources, 'bin/goose');
  verifyMachO(backend, arch);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  // Signing changes Mach-O bytes; the pre-sign hash identifies the staged source.
  // For unsigned packages the packaged backend must be byte-for-byte identical.
  if (!process.env.APPLE_TEAM_ID && sha256(backend) !== manifest.backendSha256) {
    throw new Error('Packaged backend differs from the verified stage');
  }
  if (process.platform !== 'win32') fs.accessSync(backend, fs.constants.X_OK);
  preparePty(path.join(resources, 'app.asar.unpacked'), arch, false);
  const packagedComputerHashes = {};
  for (const name of computerBinaries) {
    const file = path.join(resources, 'bin', name);
    verifyMachO(file, arch);
    if (
      !manifest.computerHashes?.[name] ||
      (!process.env.APPLE_TEAM_ID && sha256(file) !== manifest.computerHashes[name])
    )
      throw new Error(`Packaged computer runtime differs from the verified stage: ${name}`);
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    packagedComputerHashes[name] = sha256(file);
  }
  return { ...manifest, packagedBackendSha256: sha256(backend), packagedComputerHashes };
}

function bundlePaths(desktopRoot, arch) {
  targetFor(arch);
  const { productName } = require(path.join(desktopRoot, 'codebuddy.distro.json'));
  const directory = path.join(desktopRoot, 'out', `${productName}-darwin-${arch}`);
  return {
    directory,
    app: path.join(directory, `${productName}.app`),
    zip: path.join(directory, `${productName}${arch === 'x64' ? '_intel_mac' : ''}.zip`),
    dmg: path.join(directory, `${productName}-${arch}.dmg`),
  };
}

function verifyArtifact(file, arch) {
  targetFor(arch);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(path.dirname(file), 'artifacts.json'), 'utf8')
  );
  const artifact = manifest.artifacts?.find((item) => item.file === path.basename(file));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.arch !== arch ||
    !artifact ||
    artifact.bytes !== fs.statSync(file).size ||
    artifact.sha256 !== sha256(file)
  ) {
    throw new Error('Installer does not match the artifact manifest or host architecture');
  }
  return manifest;
}

module.exports = {
  targetFor,
  verifyMachO,
  stageBackend,
  verifyStage,
  stagePty,
  preparePty,
  verifyBundle,
  bundlePaths,
  sha256,
  verifyArtifact,
};
