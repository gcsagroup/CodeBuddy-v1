const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

function assertSquirrelRuntimePaths(files, installRoot) {
  let longest = 0;
  for (const file of files) {
    const installed = path.win32.join(installRoot, 'resources/harness-distribution', file.path);
    if (installed.length >= 260 || path.win32.dirname(installed).length >= 248) {
      throw new Error(`Squirrel install path exceeds legacy Windows limits (${installed.length}): ${file.path}`);
    }
    longest = Math.max(longest, installed.length);
  }
  return longest;
}

function stageInstallerTools(source, destination, arch = process.arch) {
  for (const file of ['Squirrel.exe', 'nuget.exe', `7z-${arch}.exe`, `7z-${arch}.dll`]) {
    if (!fs.existsSync(path.join(source, file))) throw new Error(`Missing installed packaging tool: ${file}`);
  }
  fs.mkdirSync(destination, { recursive: false });
  fs.cpSync(source, destination, { recursive: true, filter: file => !file.endsWith('.log') });
  for (const extension of ['exe', 'dll']) {
    fs.copyFileSync(path.join(source, `7z-${arch}.${extension}`), path.join(destination, `7z.${extension}`));
  }
  return destination;
}

async function verifyNugetPackage(archive, packaged, desktop) {
  const requireDesktop = createRequire(path.join(desktop, 'package.json'));
  const yauzl = requireDesktop('yauzl');
  const wanted = new Map(['harness-distribution/manifest.json', 'app.asar'].map(file => [
    `lib/net45/resources/${file}`,
    crypto.createHash('sha256').update(fs.readFileSync(path.join(packaged, 'resources', file))).digest('hex'),
  ]));
  await new Promise((resolve, reject) => yauzl.open(archive, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error);
    let verified = false;
    zip.on('error', reject);
    zip.on('close', () => { if (verified) resolve(); });
    zip.on('end', () => {
      if (wanted.size) reject(new Error('NuGet package is missing application identity entries'));
      else verified = true;
      zip.close();
    });
    zip.on('entry', entry => {
      if (!wanted.has(entry.fileName)) return zip.readEntry();
      zip.openReadStream(entry, (error, stream) => {
        if (error) { zip.close(); return reject(error); }
        const hash = crypto.createHash('sha256');
        stream.on('data', chunk => hash.update(chunk));
        stream.on('error', error => { zip.close(); reject(error); });
        stream.on('end', () => {
          if (hash.digest('hex') !== wanted.get(entry.fileName)) {
            zip.close(); reject(new Error(`NuGet package differs from current application: ${entry.fileName}`)); return;
          }
          wanted.delete(entry.fileName); zip.readEntry();
        });
      });
    });
    zip.readEntry();
  }));
}

async function finalizeInstaller({ desktop, vendor }) {
  const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
  const requireDesktop = createRequire(path.join(desktop, 'package.json'));
  const { convertVersion } = requireDesktop('electron-winstaller');
  const output = path.join(desktop, 'out/make/squirrel.windows/x64');
  const archive = path.join(output, `CodeBuddyHarness.${convertVersion(pkg.version)}.nupkg`);
  const target = path.join(output, 'CodeBuddy-Setup.exe');
  if (fs.existsSync(target)) throw new Error('Installer already exists; preserve it before finalizing another candidate');
  await verifyNugetPackage(archive, path.join(desktop, 'out/CodeBuddy-win32-x64'), desktop);
  // Squirrel copies its input into releaseDir, so source and destination must differ.
  const inputDirectory = path.join(vendor, 'input'); fs.mkdirSync(inputDirectory);
  const input = path.join(inputDirectory, path.basename(archive)); fs.copyFileSync(archive, input);
  const installerRoot = path.dirname(requireDesktop.resolve('electron-winstaller/package.json'));
  const result = spawnSync(path.join(vendor, 'Squirrel.exe'), [
    '--releasify', input, '--releaseDir', output,
    '--loadingGif', path.join(installerRoot, 'resources/install-spinner.gif'),
    '--setupIcon', path.join(desktop, 'src/images/icon.ico'), '--no-msi',
  ], { cwd: desktop, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Squirrel finalization exited ${result.status}`);
  fs.renameSync(path.join(output, 'Setup.exe'), target);
  return target;
}

module.exports = { stageInstallerTools, verifyNugetPackage, finalizeInstaller, assertSquirrelRuntimePaths };
