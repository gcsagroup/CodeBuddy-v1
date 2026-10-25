const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function createManifest(version, inputs) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Use a semantic product version');
  const artifacts = inputs.map(({ platform, arch, file }) => {
    if (!['win32', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw new Error('Unsupported platform/architecture');
    const name = path.basename(file);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(name) || !name.endsWith(platform === 'win32' ? '.exe' : '.zip')) throw new Error('Use an Inno EXE or signed Mac app ZIP');
    return { platform, arch, name, size: fs.statSync(file).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
  });
  if (new Set(artifacts.map(a => `${a.platform}/${a.arch}`)).size !== artifacts.length) throw new Error('Duplicate update target');
  if (!artifacts.length || artifacts.some(a => !a.size)) throw new Error('Empty update artifacts');
  return { schemaVersion: 1, version, artifacts };
}
if (require.main === module) {
  const [version, output, ...files] = process.argv.slice(2);
  if (!version || !output || !files.length) throw new Error('Usage: node scripts/create-update-manifest.cjs VERSION OUTPUT win32:x64:FILE darwin:arm64:FILE');
  const inputs = files.map(value => {
    const match = /^(win32|darwin):(x64|arm64):(.+)$/.exec(value);
    if (!match) throw new Error('Invalid artifact argument');
    return { platform: match[1], arch: match[2], file: match[3] };
  });
  fs.writeFileSync(output, JSON.stringify(createManifest(version, inputs), null, 2) + '\n', { flag: 'wx' });
}
module.exports = { createManifest };
