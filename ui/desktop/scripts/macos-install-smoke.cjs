const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { bundlePaths, sha256, verifyArtifact } = require('./macos-package.cjs');
const { verifyHarnessBundle } = require('./bundle-macos.cjs');

function main() {
  if (process.platform !== 'darwin') throw new Error('Run installation acceptance on macOS.');
  const desktop = path.resolve(__dirname, '..');
  const output = bundlePaths(desktop, process.arch);
  const dmg = path.resolve(process.argv.slice(2).find((arg) => arg !== '--') || output.dmg);
  const evidence = fs.mkdtempSync(path.join(desktop, 'out/macos-install-'));
  const mount = path.join(evidence, 'mounted');
  fs.mkdirSync(mount);
  const result = {
    status: 'FAIL',
    dmg,
    sha256: sha256(dmg),
    arch: process.arch,
    startedAt: new Date().toISOString(),
    commands: [],
    notRun: ['Finder drag-and-drop', 'Gatekeeper approval', 'Developer ID notarization acceptance'],
  };
  function run(command, args) {
    const child = spawnSync(command, args, { cwd: desktop, encoding: 'utf8' });
    result.commands.push({ command, args, exitCode: child.status, signal: child.signal });
    fs.appendFileSync(
      path.join(evidence, 'install.log'),
      JSON.stringify({ command, args }) + '\n' + (child.stdout || '') + (child.stderr || '')
    );
    if (child.error) throw child.error;
    if (child.status !== 0)
      throw new Error(`${command} exited with ${child.status ?? child.signal}`);
  }
  let attached = false;
  try {
    result.artifactManifest = verifyArtifact(dmg, process.arch);
    run('hdiutil', ['verify', dmg]);
    run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]);
    attached = true;
    const apps = fs.readdirSync(mount).filter((name) => name.endsWith('.app'));
    if (apps.length !== 1) throw new Error(`Expected one app in DMG, found ${apps.length}`);
    const installed = path.join(evidence, 'installed', apps[0]);
    fs.mkdirSync(path.dirname(installed));
    run('ditto', [path.join(mount, apps[0]), installed]);
    result.installedApp = installed;
    verifyHarnessBundle(installed, process.arch);
    run('codesign', ['--verify', '--deep', '--strict', installed]);
    // Detach first: successful launch must use only the installed copy.
    run('hdiutil', ['detach', mount]);
    attached = false;
    run(process.execPath, [path.join(__dirname, 'macos-smoke.cjs'), installed]);
    result.status = 'PASS';
  } catch (error) {
    result.error = error.message;
    process.exitCode = 1;
  } finally {
    if (attached) {
      try {
        run('hdiutil', ['detach', mount]);
      } catch (error) {
        result.detachError = error.message;
        process.exitCode = 1;
        result.status = 'FAIL';
      }
    }
    result.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(`Installation acceptance ${result.status}: ${evidence}`);
    if (result.error) console.error(result.error);
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
