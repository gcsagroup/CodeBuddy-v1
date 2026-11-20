const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const payloadManifest = '.codebuddy-runtime.json';

function prepareSerena(sourceDirectory, { repo = path.resolve(__dirname, '..'), installer = process.platform === 'win32' ? 'uv' : 'pip3' } = {}) {
  const source = fs.realpathSync(sourceDirectory);
  const assets = path.join(repo, 'runtime/assets');
  const provenance = JSON.parse(fs.readFileSync(path.join(assets, 'serena-runtime.json'), 'utf8'));
  const destination = path.join(assets, 'serena');
  if (fs.existsSync(destination)) throw new Error('Preserve the existing Serena payload; choose an explicit backup before preparing a replacement.');
  function run(command, args, capture = false) {
    const result = spawnSync(command, args, { cwd: source, shell: false, windowsHide: true,
      ...(capture ? { encoding: 'utf8' } : { stdio: 'inherit' }) });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${path.basename(command)} exited ${result.status ?? result.signal}`);
    return result.stdout?.trim();
  }
  if (run('git', ['rev-parse', 'HEAD'], true) !== provenance.revision ||
      run('git', ['status', '--porcelain', '--untracked-files=normal'], true))
    throw new Error('Serena preparation requires a clean checkout of the pinned revision.');
  if (!fs.readFileSync(path.join(source, 'LICENSE'), 'utf8').startsWith('MIT License'))
    throw new Error('The pinned Serena source must retain its MIT license.');
  const python = path.join(repo, 'runtime/py/dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
  const identity = JSON.parse(run(python, ['-I', '-B', '-c',
    'import sys,platform,json; print(json.dumps({"platform":sys.platform,"arch":platform.machine().lower(),"python":"%s.%s"%sys.version_info[:2]}))'], true));
  const architecture = { amd64: 'x64', x86_64: 'x64', aarch64: 'arm64', arm64: 'arm64' }[identity.arch];
  if (identity.platform !== process.platform || architecture !== process.arch || identity.python !== provenance.python)
    throw new Error('Use the bundled Python matching this host and the pinned Python version.');
  const parent = path.join(repo, 'target');
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, 'serena-prepare-'));
  const uv = /^uv(?:\.exe)?$/i.test(path.basename(installer));
  const args = uv
    ? ['pip', 'install', '--python', python, '--target', staging, source]
    : ['--python', python, 'install', '--no-compile', '--target', staging, '--report', path.join(staging, '.install-report.json'), source];
  run(installer, args);
  const installed = run(python, ['-I', '-B', '-c',
    'import sys; sys.path.insert(0,sys.argv[1]); import serena.cli; import importlib.metadata as m; print(m.version("serena-agent"))', staging], true);
  if (installed !== provenance.packageVersion) throw new Error('Installed Serena version does not match the pinned source.');
  const manifest = { ...provenance, platform: process.platform, arch: process.arch, python: identity.python };
  fs.writeFileSync(path.join(staging, payloadManifest), JSON.stringify(manifest, null, 2) + '\n');
  fs.renameSync(staging, destination);
  return { destination, ...manifest };
}

module.exports = { prepareSerena, payloadManifest };
if (require.main === module) {
  const [source, installer] = process.argv.slice(2);
  if (!source) { console.error('Usage: node scripts/prepare-serena-runtime.cjs SOURCE_DIRECTORY [INSTALLER]'); process.exitCode = 1; }
  else try { console.log(JSON.stringify(prepareSerena(source, installer ? { installer } : {}))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
