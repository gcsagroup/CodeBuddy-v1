const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

async function preparePyright(repo = path.resolve(__dirname, '..')) {
  const assets = path.join(repo, 'runtime/assets');
  const expected = JSON.parse(await fs.readFile(path.join(assets, 'pyright-runtime.json'), 'utf8'));
  const destination = path.join(assets, 'pyright');
  if (await fs.stat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; }))
    throw new Error('Preserve the existing Pyright payload before preparing a replacement.');
  const response = await fetch(expected.url, { redirect: 'error', signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Pyright download HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const integrity = 'sha512-' + crypto.createHash('sha512').update(archive).digest('base64');
  if (integrity !== expected.integrity) throw new Error('Pyright archive integrity mismatch');
  const parent = path.join(repo, 'target');
  await fs.mkdir(parent, { recursive: true });
  const staging = await fs.mkdtemp(path.join(parent, 'pyright-prepare-'));
  const archivePath = path.join(staging, 'pyright.tgz');
  await fs.writeFile(archivePath, archive);
  const python = path.join(repo, 'runtime/py/dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
  const unpack = spawnSync(python, ['-I', '-B', '-c',
    'import sys,tarfile,pathlib\nwith tarfile.open(sys.argv[1]) as archive:\n for member in archive.getmembers():\n  parts=pathlib.PurePosixPath(member.name).parts\n  if not parts or parts[0]!="package" or ".." in parts or not (member.isfile() or member.isdir()): raise ValueError("Unsafe Pyright archive member")\n archive.extractall(sys.argv[2],filter="data")',
    archivePath, staging], { stdio: 'inherit', windowsHide: true });
  if (unpack.error) throw unpack.error;
  if (unpack.status !== 0) throw new Error(`Pyright extraction exited ${unpack.status}`);
  const payload = path.join(staging, 'package');
  const installed = JSON.parse(await fs.readFile(path.join(payload, 'package.json'), 'utf8'));
  if (installed.name !== expected.name || installed.version !== expected.version || installed.license !== expected.license)
    throw new Error('Pyright package identity mismatch');
  await fs.access(path.join(payload, 'LICENSE.txt'));
  await fs.access(path.join(payload, 'dist/pyright-langserver.js'));
  await fs.writeFile(path.join(payload, '.codebuddy-runtime.json'), JSON.stringify(expected, null, 2) + '\n');
  await fs.rename(payload, destination);
  return { destination, version: expected.version, integrity };
}

module.exports = { preparePyright };
if (require.main === module) preparePyright().then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(error.message); process.exitCode = 1;
});
