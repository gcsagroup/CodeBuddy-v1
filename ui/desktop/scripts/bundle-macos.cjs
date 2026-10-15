const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { buildMacComputer } = require('./build-macos-computer.cjs');
const {
  targetFor,
  stageBackend,
  bundlePaths,
  verifyMachO,
  verifyBundle,
  sha256,
} = require('./macos-package.cjs');

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} exited with ${result.status ?? result.signal}`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      arch: { type: 'string', default: process.arch },
      backend: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'Usage: pnpm run bundle:mac --arch arm64|x64 [--backend /absolute/path/to/release/goose]\nRun on a Mac of the selected architecture. Without --backend, builds the Release backend first.'
    );
    return;
  }
  const target = targetFor(values.arch);
  if (process.platform !== 'darwin' || process.arch !== values.arch) {
    throw new Error(
      `Run this build natively on a ${values.arch} Mac; native addons and Apple signing require macOS.`
    );
  }
  const desktop = path.resolve(__dirname, '..');
  const repo = path.resolve(desktop, '../..');
  const deployment = process.env.MACOSX_DEPLOYMENT_TARGET || '14.0';
  const env = { ...process.env, MACOSX_DEPLOYMENT_TARGET: deployment };
  const backend = values.backend
    ? path.resolve(values.backend)
    : path.join(repo, 'target', target, 'release/goose');
  if (!values.backend)
    run(
      'cargo',
      [
        'build',
        '--release',
        '-p',
        'goose-cli',
        '--bin',
        'goose',
        '--target',
        target,
        '--jobs',
        '1',
      ],
      repo,
      env
    );
  verifyMachO(backend, values.arch);
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
  if (revision.status !== 0 || status.status !== 0)
    throw new Error('Could not record source identity');
  const computerDirectory = buildMacComputer(repo, values.arch);
  const stage = stageBackend(
    desktop,
    backend,
    values.arch,
    {
      revision: revision.stdout.trim(),
      dirty: status.stdout.length > 0,
      backend: values.backend ? 'provided-release-artifact' : 'local-release-build',
      deployment,
    },
    computerDirectory
  );
  env.CODEBUDDY_BACKEND_RESOURCE_DIR = stage.resourceDirectory;
  env.CODEBUDDY_BACKEND_MANIFEST_PATH = stage.manifestPath;
  run('pnpm', ['run', 'make', '--platform=darwin', `--arch=${values.arch}`], desktop, env);
  const output = bundlePaths(desktop, values.arch);
  const packagedManifest = verifyBundle(output.app, values.arch, stage.manifestPath);
  if (!process.env.APPLE_TEAM_ID) {
    // Packager changes Electron's plist and helpers after the fuse hook. Seal the
    // completed local-test bundle only after checking all unsigned source hashes.
    const { signAsync } = require('@electron/osx-sign');
    await signAsync({
      app: output.app,
      platform: 'darwin',
      identity: '-',
      identityValidation: false,
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false,
      optionsForFile: () => ({
        entitlements: path.join(desktop, 'entitlements.plist'),
        hardenedRuntime: false,
      }),
    });
  }
  run('codesign', ['--verify', '--deep', '--strict', output.app], desktop, env);
  packagedManifest.signing = process.env.APPLE_TEAM_ID ? 'developer-id' : 'ad-hoc';
  packagedManifest.packagedBackendSha256 = sha256(
    path.join(output.app, 'Contents/Resources/bin/goose')
  );
  for (const name of Object.keys(packagedManifest.packagedComputerHashes)) {
    packagedManifest.packagedComputerHashes[name] = sha256(
      path.join(output.app, 'Contents/Resources/bin', name)
    );
  }
  run(
    process.execPath,
    [path.join(__dirname, 'verify-mac-update-resources.js'), output.app],
    desktop,
    env
  );
  run(
    'ditto',
    ['-c', '-k', '--sequesterRsrc', '--keepParent', output.app, output.zip],
    desktop,
    env
  );
  // A separate image root keeps ZIPs and build metadata outside the installer.
  const imageRoot = fs.mkdtempSync(path.join(path.dirname(stage.resourceDirectory), 'dmg-'));
  run('ditto', [output.app, path.join(imageRoot, path.basename(output.app))], desktop, env);
  fs.symlinkSync('/Applications', path.join(imageRoot, 'Applications'));
  run(
    'hdiutil',
    [
      'create',
      '-ov',
      '-format',
      'UDZO',
      '-volname',
      path.basename(output.app, '.app'),
      '-srcfolder',
      imageRoot,
      output.dmg,
    ],
    desktop,
    env
  );
  run('hdiutil', ['verify', output.dmg], desktop, env);
  fs.writeFileSync(
    path.join(output.directory, 'backend-manifest.json'),
    JSON.stringify(packagedManifest, null, 2) + '\n'
  );
  const artifacts = [output.zip, output.dmg].map((file) => ({
    file: path.basename(file),
    bytes: fs.statSync(file).size,
    sha256: sha256(file),
  }));
  fs.writeFileSync(
    path.join(output.directory, 'artifacts.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        version: require('../package.json').version,
        arch: values.arch,
        source: packagedManifest.source,
        signing: packagedManifest.signing,
        artifacts,
      },
      null,
      2
    ) + '\n'
  );
  fs.writeFileSync(
    path.join(output.directory, 'SHA256SUMS'),
    artifacts.map((artifact) => `${artifact.sha256}  ${artifact.file}`).join('\n') + '\n'
  );
  console.log(
    `macOS ${values.arch} packages:\n${output.dmg}\n${output.zip}\nManifest: ${output.directory}/artifacts.json`
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
