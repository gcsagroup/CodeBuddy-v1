const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

function buildOptions(args) {
  const installer = args.find(arg => arg.startsWith('--installer='))?.slice(12) ?? 'squirrel';
  if (!['inno', 'squirrel'].includes(installer)) throw new Error('Installer must be inno or squirrel');
  const unknown = args.filter(arg => arg.startsWith('--') && !['--make-only', '--finalize-only'].includes(arg) && !arg.startsWith('--installer='));
  const stages = args.filter(arg => !arg.startsWith('--'));
  if (unknown.length || stages.length > 1) throw new Error('Usage: build-harness-windows.cjs [stage-directory] [--installer=inno|squirrel] [--make-only|--finalize-only]');
  const finalizeOnly = args.includes('--finalize-only');
  if (finalizeOnly && installer !== 'squirrel') throw new Error('--finalize-only is only available for Squirrel');
  return { installer, stage: stages[0], finalizeOnly, makeOnly: finalizeOnly || args.includes('--make-only') };
}

function resolveCompiler(env = process.env) {
  const candidates = [env.CODEBUDDY_ISCC];
  for (const base of [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'), env['ProgramFiles(x86)'], env.ProgramFiles].filter(Boolean)) {
    for (const version of [7, 6]) candidates.push(path.join(base, `Inno Setup ${version}`, 'ISCC.exe'));
  }
  const compiler = candidates.find(file => file && fs.existsSync(file));
  if (!compiler) throw new Error('Inno Setup 6.7+ is required. Set CODEBUDDY_ISCC to the approved ISCC.exe; this build never installs tools automatically.');
  const chineseMessages = env.CODEBUDDY_INNO_ZH_CN ?? path.join(path.dirname(compiler), 'Languages', 'ChineseSimplified.isl');
  if (!fs.existsSync(chineseMessages)) throw new Error('Prepare the pinned Inno Setup ChineseSimplified.isl translation or set CODEBUDDY_INNO_ZH_CN.');
  return { compiler: path.resolve(compiler), chineseMessages: path.resolve(chineseMessages) };
}

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function stageInstallerApplication(packaged, longestRelativePath, temporaryRoot = os.tmpdir()) {
  if (packaged.length + 1 + longestRelativePath <= 259) return packaged;
  const input = fs.mkdtempSync(path.join(temporaryRoot, 'cb-inst-'));
  if (input.length + 1 + longestRelativePath > 259) throw new Error('Installer build needs a shorter approved temporary directory');
  // Inno 6 cannot open the long source paths in a managed worktree. This is a
  // copy of the completed application, not a different checkout or runtime.
  fs.cpSync(packaged, input, { recursive: true });
  return input;
}

function inspectApplication(packaged, stage) {
  const manifestFile = path.join(packaged, 'resources/harness-distribution/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.engine !== 'deepseek-harness' || manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) throw new Error('Invalid packaged runtime manifest');
  if (hash(manifestFile) !== hash(path.join(stage, 'manifest.json'))) throw new Error('Packaged application does not match the current runtime stage');
  for (const file of ['CodeBuddy.exe', 'resources/app.asar']) {
    if (!fs.statSync(path.join(packaged, file)).isFile()) throw new Error(`Missing packaged file: ${file}`);
  }
  const prefix = path.resolve(packaged, 'resources/harness-distribution') + path.sep;
  for (const entry of manifest.files) {
    const file = path.resolve(packaged, 'resources/harness-distribution', entry.path);
    if (!file.startsWith(prefix) || hash(file) !== entry.sha256) throw new Error(`Packaged runtime identity mismatch: ${entry.path}`);
  }
  let longestRelativePath = 0;
  let files = 0;
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Installer input must not contain links: ${full}`);
      if (entry.isDirectory()) walk(full);
      else { longestRelativePath = Math.max(longestRelativePath, path.relative(packaged, full).length); files += 1; }
    }
  };
  walk(packaged);
  return { sourceDigest: manifest.sourceDigest, appAsarSha256: hash(path.join(packaged, 'resources/app.asar')), longestRelativePath, files };
}

function makeWizardInstaller({ root, stage, tools = resolveCompiler() }) {
  const desktop = path.join(root, 'ui/desktop');
  const packaged = path.join(desktop, 'out/CodeBuddy-win32-x64');
  const identity = inspectApplication(packaged, stage);
  const compilerInput = stageInstallerApplication(packaged, identity.longestRelativePath);
  if (compilerInput !== packaged) {
    const copied = inspectApplication(compilerInput, stage);
    if (copied.appAsarSha256 !== identity.appAsarSha256 || copied.files !== identity.files) throw new Error('Short installer input differs from the completed application');
  }
  const { version } = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
  const output = path.join(desktop, 'out/make/inno.windows/x64');
  fs.mkdirSync(output, { recursive: true });
  const target = path.join(output, 'CodeBuddy-Setup.exe');
  if (fs.existsSync(target)) throw new Error('Installer already exists; preserve it before building another candidate');
  const args = [`/DAppSource=${compilerInput}`, `/DAppVersion=${version}`, `/DOutputDir=${output}`,
    `/DProductIcon=${path.join(desktop, 'src/images/icon.ico')}`, `/DProductImage=${path.join(desktop, 'src/images/icon-512.png')}`,
    `/DChineseMessages=${tools.chineseMessages}`, `/DMaxRelativePath=${identity.longestRelativePath}`,
    path.join(root, 'scripts/installer/codebuddy.iss')];
  const result = spawnSync(tools.compiler, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Inno Setup compilation exited ${result.status}`);
  if (!fs.existsSync(target)) throw new Error('Inno Setup did not produce CodeBuddy-Setup.exe');
  const receipt = { installer: 'inno', version, builtAt: new Date().toISOString(), compiler: tools.compiler, compilerInput,
    ...identity, installerSha256: hash(target), installerBytes: fs.statSync(target).size };
  fs.writeFileSync(path.join(output, 'build-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  return { target, ...receipt };
}

module.exports = { buildOptions, resolveCompiler, inspectApplication, stageInstallerApplication, makeWizardInstaller };
