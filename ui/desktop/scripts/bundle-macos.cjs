'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { stageHarness } = require('../../../scripts/stage-harness-distribution.cjs');
const { targetFor, bundlePaths, verifyMachO, preparePty, sha256, verifySourceSnapshot } = require('./macos-package.cjs');
const { buildMacTools } = require('../../../scripts/prepare-harness-macos-tools.cjs');
const { verifyMacArtifacts, macSigningOptionsForFile, ignoreNonMacCode } = require('../../../scripts/macos-tool-artifacts.cjs');
const { signingPlan, inspectSignature } = require('./macos-signing.cjs');
const { macArtifactFiles } = require('../../../runtime/builtin-artifacts.mjs');
const { buildDmg } = require('./macos-dmg.cjs');

function run(command, args, cwd, env = process.env, capture = false) {
  const result = spawnSync(command, args, {
    cwd, env, shell: false, ...(capture ? { encoding: 'utf8' } : { stdio: 'inherit' }),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? result.signal}`);
  return result.stdout?.trim();
}

function verifyHarnessBundle(app, arch, expectedManifest, phase) {
  const resources = path.join(app, 'Contents/Resources');
  const root = path.join(resources, 'harness-distribution');
  const manifest = fs.readFileSync(path.join(root, 'manifest.json'), 'utf8');
  if (expectedManifest !== undefined && manifest !== expectedManifest)
    throw new Error('Packaged Harness manifest differs from this build stage');
  const parsed = JSON.parse(manifest);
  if (parsed.engine !== 'deepseek-harness' || parsed.schemaVersion !== 1)
    throw new Error('Invalid packaged Harness manifest');
  verifyMachO(path.join(root, 'node/node'), arch);
  const office = JSON.parse(fs.readFileSync(path.join(root, 'runtime/py/runtime.json'), 'utf8'));
  if (office.platform !== 'darwin' || office.arch !== arch)
    throw new Error('Packaged Office payload does not match macOS architecture');
  for (const entry of parsed.files) {
    if (/(?:^|\/)(?:goose|goosed)(?:\.exe)?$|^runtime\/tools\/bin\/.*\.exe$/i.test(entry.path))
      throw new Error(`Unexpected executable in macOS Harness stage: ${entry.path}`);
  }
  preparePty(path.join(resources, 'app.asar.unpacked'), arch, false);
  verifyMacArtifacts(path.join(root, 'runtime/tools'), arch, phase);
  return root;
}

async function main() {
  const { values } = parseArgs({ options: {
    arch: { type: 'string', default: process.arch },
    'node-license': { type: 'string' },
    'source-manifest': { type: 'string' },
    help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/build-harness-macos.cjs --arch arm64|x64 --node-license /path/to/Node/LICENSE [--source-manifest snapshot.json]\nRun with existing native Node 24+ and prepared native Office/UI/Harness dependencies. A synchronized checkout can provide a file-hash manifest to verify source identity before and after packaging. No legacy Rust Agent is built.');
    return;
  }
  targetFor(values.arch);
  if (process.platform !== 'darwin' || process.arch !== values.arch || Number(process.versions.node.split('.')[0]) < 24)
    throw new Error(`Use existing native Node 24+ on a ${values.arch} Mac`);
  if (!values['node-license']) throw new Error('--node-license must identify the LICENSE from this Node distribution');
  const signing = signingPlan();
  const desktop = path.resolve(__dirname, '..');
  const repo = path.resolve(desktop, '../..');
  const checkout = {
    revision: run('git', ['rev-parse', 'HEAD'], repo, process.env, true),
    dirty: run('git', ['status', '--porcelain'], repo, process.env, true).length > 0,
  };
  const sourceManifest = values['source-manifest'] && path.resolve(values['source-manifest']);
  const source = sourceManifest
    ? { ...verifySourceSnapshot(repo, sourceManifest), checkoutRevision: checkout.revision }
    : checkout;
  verifyMachO(process.execPath, values.arch);
  const parent = path.join(repo, 'target');
  fs.mkdirSync(parent, { recursive: true });
  const build = fs.mkdtempSync(path.join(parent, `harness-macos-${values.arch}-`));
  const stage = path.join(build, 'harness-distribution');
  const env = { ...process.env, CODEBUDDY_HARNESS_RESOURCE_DIR: stage };
  run(process.execPath, [require.resolve('typescript/bin/tsc'), '--project', path.join(repo, 'ui/sdk/tsconfig.json')], desktop, env);
  run(process.execPath, [path.join(desktop, 'scripts/i18n-compile.js')], desktop, env);
  const toolsDirectory = buildMacTools(repo, values.arch, source);
  await stageHarness(repo, stage, { nodeLicense: path.resolve(values['node-license']), toolsDirectory });
  const stageManifest = fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8');
  run(path.join(stage, 'node/node'), [path.join(repo, 'scripts/verify-harness-stage.mjs'), stage], repo, env);
  const forgePackage = require.resolve('@electron-forge/cli/package.json');
  const forge = JSON.parse(fs.readFileSync(forgePackage, 'utf8'));
  run(process.execPath, [path.resolve(path.dirname(forgePackage), forge.bin['electron-forge']), 'package', '--platform=darwin', `--arch=${values.arch}`], desktop, env);
  const output = bundlePaths(desktop, values.arch);
  verifyHarnessBundle(output.app, values.arch, stageManifest);
  if (signing.kind === 'ad-hoc') {
    const { signAsync } = require('@electron/osx-sign');
    await signAsync({
      app: output.app, platform: 'darwin', identity: '-', identityValidation: false,
      // Keep the predicate form: osx-sign 1.3.3 discards array-form ignore.
      ignore: ignoreNonMacCode,
      preAutoEntitlements: false, preEmbedProvisioningProfile: false,
      optionsForFile: file => macSigningOptionsForFile(file, path.join(desktop, 'entitlements.plist'), false),
    });
  }
  run('codesign', ['--verify', '--deep', '--strict', output.app], desktop, env);
  const packaged = verifyHarnessBundle(output.app, values.arch, stageManifest, 'signed');
  const signatures = { app: inspectSignature(output.app, signing) };
  if (signatures.app.identifier !== 'local.codebuddy.desktop') throw new Error('Unexpected application signing identifier');
  for (const file of Object.values(macArtifactFiles))
    signatures[file] = inspectSignature(path.join(packaged, 'runtime/tools/bin', file), { ...signing, teamId: signatures.app.teamId });
  // Exercise the installed-layout interpreter and libraries after signing.
  run(path.join(packaged, 'node/node'), [path.join(repo, 'scripts/verify-harness-stage.mjs'), packaged, build], repo, env);
  run('codesign', ['--verify', '--deep', '--strict', output.app], desktop, env);
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', output.app, output.zip], desktop, env);
  buildDmg({ app: output.app, dmg: output.dmg, build,
    run: (command, args) => run(command, args, desktop, env) });
  const artifacts = [output.zip, output.dmg].map(file => ({ file: path.basename(file), bytes: fs.statSync(file).size, sha256: sha256(file) }));
  if (sourceManifest) {
    const verified = verifySourceSnapshot(repo, sourceManifest);
    if (verified.snapshotSha256 !== source.snapshotSha256) throw new Error('Source snapshot changed during build');
  }
  fs.writeFileSync(path.join(output.directory, 'artifacts.json'), JSON.stringify({
    schemaVersion: 1, createdAt: new Date().toISOString(), version: require('../package.json').version,
    arch: values.arch, source, sourceDigest: JSON.parse(stageManifest).sourceDigest,
    signing: signing.kind, signatures, notarized: Boolean(signing.notarize), artifacts,
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(output.directory, 'SHA256SUMS'), artifacts.map(a => `${a.sha256}  ${a.file}`).join('\n') + '\n');
  console.log(`macOS ${values.arch}: ${output.dmg}\n${output.zip}\nSource: ${source.revision} (dirty=${source.dirty})`);
}

module.exports = { main, verifyHarnessBundle };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
