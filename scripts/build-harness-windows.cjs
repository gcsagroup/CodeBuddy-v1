const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { stageHarness } = require('./stage-harness-distribution.cjs');
const { stageInstallerTools, finalizeInstaller, assertSquirrelRuntimePaths } = require('./windows-installer-tools.cjs');
const { buildOptions, resolveCompiler, makeWizardInstaller } = require('./windows-wizard-installer.cjs');

async function main() {
  if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) < 24) throw new Error('Use existing Node 24+ on Windows');
  const root = path.resolve(__dirname, '..');
  const desktop = path.join(root, 'ui/desktop');
  const options = buildOptions(process.argv.slice(2));
  const stage = options.stage ? path.resolve(options.stage) : path.join(root, 'target', `harness-package-${Date.now()}`, 'harness-distribution');
  const { finalizeOnly, makeOnly } = options;
  // Missing build tools fail before any compile or staging; never auto-install.
  const innoTools = options.installer === 'inno' ? resolveCompiler() : null;
  if (!makeOnly && !fs.existsSync(path.join(root, 'runtime/py/runtime.json'))) {
    throw new Error('Prepare the approved Office payload first; see scripts/office-builder/README.md');
  }
  const toolsParent = path.join(root, 'target'); fs.mkdirSync(toolsParent, { recursive: true });
  let vendor;
  if (options.installer === 'squirrel') {
    const installerRoot = path.dirname(require.resolve('electron-winstaller/package.json', { paths: [desktop] }));
    vendor = stageInstallerTools(path.join(installerRoot, 'vendor'), path.join(toolsParent, `harness-winstaller-${Date.now()}`));
  }
  const run = (args, cwd, executable = process.execPath) => {
    const result = spawnSync(executable, args, { cwd, stdio: 'inherit', windowsHide: true, env: { ...process.env, CODEBUDDY_HARNESS_RESOURCE_DIR: stage, ...(vendor ? { CODEBUDDY_HARNESS_VENDOR_DIR: vendor } : {}) } });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Build step exited ${result.status}`);
  };
  if (!makeOnly) {
    run([require.resolve('typescript/bin/tsc', { paths: [desktop] }), '--project', path.join(root, 'ui/sdk/tsconfig.json')], desktop);
    run([path.join(desktop, 'scripts/i18n-compile.js')], desktop);
  } else if (!fs.existsSync(stage)) {
    throw new Error('--make-only requires an existing verified stage and packaged application');
  }
  if (makeOnly) {
    const packaged = path.join(desktop, 'out/CodeBuddy-win32-x64');
    const stagedManifest = fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8');
    const packagedManifest = fs.readFileSync(path.join(packaged, 'resources/harness-distribution/manifest.json'), 'utf8');
    if (!fs.existsSync(path.join(packaged, 'CodeBuddy.exe')) || stagedManifest !== packagedManifest) {
      throw new Error('--make-only requires a packaged application matching this Harness stage');
    }
  }
  if (!fs.existsSync(stage)) {
    fs.mkdirSync(path.dirname(stage), { recursive: true });
    await stageHarness(root, stage);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8'));
  const { version } = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
  if (options.installer === 'squirrel') {
    if (!process.env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is required to validate Squirrel install paths');
    const longestInstallPath = assertSquirrelRuntimePaths(manifest.files, path.join(process.env.LOCALAPPDATA, 'CodeBuddyHarness', `app-${version}`));
    console.log(JSON.stringify({ squirrelInstallPathsVerified: true, longestInstallPath }));
  }
  if (finalizeOnly) { console.log(await finalizeInstaller({ desktop, vendor })); return; }
  run([path.join(root, 'scripts/verify-harness-stage.mjs'), stage], root, path.join(stage, 'node/node.exe'));
  const forgePackage = require.resolve('@electron-forge/cli/package.json', { paths: [desktop] });
  const forge = JSON.parse(fs.readFileSync(forgePackage, 'utf8'));
  const forgeBin = path.resolve(path.dirname(forgePackage), forge.bin['electron-forge']);
  if (options.installer === 'inno') {
    if (!makeOnly) run([forgeBin, 'package', '--platform=win32', '--arch=x64'], desktop);
    console.log(JSON.stringify(makeWizardInstaller({ root, stage, tools: innoTools })));
  } else {
    run([forgeBin, 'make', '--platform=win32', '--arch=x64', '--targets=@electron-forge/maker-squirrel', ...(makeOnly ? ['--skip-package'] : [])], desktop);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
