const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');

function assertPinnedPair(expected) {
  if (expected.packages?.length !== 2 ||
      [...expected.packages.map(item => item.name)].sort().join(',') !== 'typescript,typescript-language-server')
    throw new Error('TypeScript preparation requires the pinned compiler and language-server pair.');
}

async function validateTypeScriptPayload(payload, expected) {
  try {
    assertPinnedPair(expected);
    const root = await fs.realpath(payload);
    const file = async relative => {
      const resolved = await fs.realpath(path.join(payload, relative));
      const location = path.relative(root, resolved);
      if (location === '..' || location.startsWith('..' + path.sep) || path.isAbsolute(location))
        throw new Error(`TypeScript payload entry is outside the prepared directory: ${relative}`);
      if (!(await fs.stat(resolved)).isFile()) throw new Error(`TypeScript payload entry is not a file: ${relative}`);
      return resolved;
    };
    const actual = JSON.parse(await fs.readFile(await file('.codebuddy-runtime.json'), 'utf8'));
    if (!isDeepStrictEqual(actual, expected)) throw new Error('TypeScript payload provenance mismatch');
    for (const item of expected.packages) {
      const source = path.join('node_modules', item.name);
      const manifest = JSON.parse(await fs.readFile(await file(path.join(source, 'package.json')), 'utf8'));
      if (manifest.name !== item.name || manifest.version !== item.version || manifest.license !== item.license)
        throw new Error(`${item.name} package identity mismatch`);
      await file(path.join(source, item.licenseFile));
      const entries = item.name === 'typescript-language-server' ? ['cli.mjs']
        : ['tsserver.js', '_tsserver.js', 'typescript.js', 'typingsInstaller.js', '_typingsInstaller.js'];
      for (const entry of entries)
        await file(path.join(source, 'lib', entry));
    }
  } catch (error) {
    throw new Error(`TypeScript payload is not ready; run scripts/prepare-typescript-runtime.cjs explicitly before packaging: ${error.message}`, { cause: error });
  }
}

// An explicit preparation command, never called by navigation or startup.
// Follow the existing Pyright preparation path; npm install is not involved.
async function prepareTypeScript(repo = path.resolve(__dirname, '..'), {
  request = fetch,
  python = path.join(repo, 'runtime/py/dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3'),
} = {}) {
  repo = await fs.realpath(repo);
  const assets = path.join(repo, 'runtime/assets');
  const expected = JSON.parse(await fs.readFile(path.join(assets, 'typescript-runtime.json'), 'utf8'));
  assertPinnedPair(expected);
  for (const item of expected.packages) {
    const url = new URL(item.url);
    if (url.origin !== 'https://registry.npmjs.org' || url.pathname !== `/${item.name}/-/${item.name}-${item.version}.tgz` || url.search || url.hash)
      throw new Error('TypeScript preparation requires the pinned official registry URL.');
  }
  const destination = path.join(assets, 'typescript');
  if (await fs.lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; }))
    throw new Error('Preserve the existing TypeScript payload before preparing a replacement.');
  const parent = path.resolve(repo, 'target');
  await fs.mkdir(parent, { recursive: true });
  const resolvedParent = await fs.realpath(parent);
  if (path.relative(parent, resolvedParent) !== '') throw new Error('TypeScript staging must resolve inside this repository target directory.');
  const staging = await fs.mkdtemp(path.join(parent, 'typescript-prepare-'));
  if (path.relative(resolvedParent, path.dirname(await fs.realpath(staging))) !== '')
    throw new Error('Invalid TypeScript staging directory.');
  try {
    const payload = path.join(staging, 'payload');
    await fs.mkdir(path.join(payload, 'node_modules'), { recursive: true });
    for (const item of expected.packages) {
      const response = await request(item.url, { redirect: 'error', signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`${item.name} download HTTP ${response.status}`);
      const archive = Buffer.from(await response.arrayBuffer());
      const integrity = 'sha512-' + crypto.createHash('sha512').update(archive).digest('base64');
      if (integrity !== item.integrity) throw new Error(`${item.name} archive integrity mismatch`);
      const archivePath = path.join(staging, item.name + '.tgz');
      const unpacked = path.join(staging, item.name);
      await fs.writeFile(archivePath, archive);
      const unpack = spawnSync(python, ['-I', '-B', '-c',
        'import sys,tarfile,pathlib\nwith tarfile.open(sys.argv[1]) as archive:\n for member in archive.getmembers():\n  parts=pathlib.PurePosixPath(member.name).parts\n  if not parts or parts[0]!="package" or ".." in parts or not (member.isfile() or member.isdir()): raise ValueError("Unsafe TypeScript archive member")\n archive.extractall(sys.argv[2],filter="data")',
        archivePath, unpacked], { windowsHide: true, encoding: 'utf8' });
      if (unpack.error) throw unpack.error;
      if (unpack.status !== 0) throw new Error(`${item.name} extraction exited ${unpack.status}: ${unpack.stderr.trim()}`);
      const source = path.join(unpacked, 'package');
      await fs.rename(source, path.join(payload, 'node_modules', item.name));
    }
    await fs.writeFile(path.join(payload, '.codebuddy-runtime.json'), JSON.stringify(expected, null, 2) + '\n');
    await validateTypeScriptPayload(payload, expected);
    await fs.rename(payload, destination);
    return { destination, packages: expected.packages };
  } finally {
    const cleanup = await fs.realpath(staging).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (cleanup) {
      if (path.relative(resolvedParent, path.dirname(cleanup)) !== '' || !path.basename(cleanup).startsWith('typescript-prepare-'))
        throw new Error('Refusing to clean a TypeScript staging path outside this repository target directory.');
      await fs.rm(cleanup, { recursive: true, force: true });
    }
  }
}

module.exports = { prepareTypeScript, validateTypeScriptPayload };
if (require.main === module) prepareTypeScript().then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(error.message); process.exitCode = 1;
});
