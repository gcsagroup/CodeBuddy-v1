const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { dependencyClosure, commonJsImports, profilePackageNames } = require('./harness-dependencies.cjs');

function distributionTarget(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'x64') return { node: 'node.exe', office: 'win-x64' };
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) return { node: 'node', office: `mac-${arch}` };
  throw new Error(`Unsupported Harness distribution: ${platform}/${arch}`);
}

function assertOfficeTarget(manifest, platform = process.platform, arch = process.arch) {
  distributionTarget(platform, arch);
  if (manifest.platform !== platform || manifest.arch !== arch)
    throw new Error(`Office payload ${manifest.platform}/${manifest.arch} does not match ${platform}/${arch}`);
}

async function stageHarness(repoRoot, destination, options = {}) {
  const target = distributionTarget();
  if (Number(process.versions.node.split('.')[0]) < 24)
    throw new Error('Stage with the existing native Node 24+ runtime');
  const runtime = path.join(repoRoot, 'runtime');
  const officeManifest = await fs.readFile(path.join(runtime, 'py/runtime.json'), 'utf8').catch(() => {
    throw new Error('Prepare the approved native Office payload with node scripts/prepare-harness-office.mjs before packaging');
  });
  assertOfficeTarget(JSON.parse(officeManifest));
  const toolsDirectory = options.toolsDirectory || path.join(runtime, 'tools');
  if (process.platform === 'darwin') {
    const { verifyMacArtifacts } = require('./macos-tool-artifacts.cjs');
    verifyMacArtifacts(toolsDirectory, process.arch, 'staged');
  }
  // Windows MSI installs can omit the adjacent license; use the matching bundled release.
  let nodeLicense = options.nodeLicense || path.join(path.dirname(process.execPath), 'LICENSE');
  if (!options.nodeLicense && !await fs.stat(nodeLicense).catch(error => { if (error.code !== 'ENOENT') throw error; })) {
    nodeLicense = path.join(runtime, 'tools/licenses', `node-v${process.versions.node}-LICENSE.txt`);
  }
  await fs.access(nodeLicense).catch(() => {
    throw new Error(`Missing Node ${process.versions.node} distribution license: ${nodeLicense}`);
  });
  // Each build uses a fresh stage. Never delete a prior candidate or profile.
  await fs.mkdir(destination, { recursive: false });
  const copy = async (source, target) => {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(source, target, { recursive: true, dereference: true, filter: file => !['.bin', '.cache', '.DS_Store'].includes(path.basename(file)) });
  };
  await copy(process.execPath, path.join(destination, 'node', target.node));
  await copy(path.join(runtime, 'py'), path.join(destination, 'runtime/py'));
  await copy(path.join(runtime, 'office'), path.join(destination, 'runtime/office'));
  await copy(nodeLicense, path.join(destination, 'node/LICENSE'));
  for (const entry of await fs.readdir(runtime, { withFileTypes: true })) {
    if (entry.isFile() && /\.(mjs|cjs|json)$/.test(entry.name) || entry.name === 'assets') {
      await copy(path.join(runtime, entry.name), path.join(destination, 'runtime', entry.name));
    }
  }
  const harness = path.join(runtime, 'harness');
  const harnessEntries = await fs.readdir(harness, { withFileTypes: true });
  for (const entry of harnessEntries) {
    if ((entry.isFile() && /\.(mjs|json)$/.test(entry.name)) || entry.name === 'skills') {
      await copy(path.join(runtime, 'harness', entry.name), path.join(destination, 'runtime/harness', entry.name));
    }
  }
  const requireDesktop = createRequire(path.join(repoRoot, 'ui/desktop/package.json'));
  const { init, parse } = requireDesktop('es-module-lexer');
  const typescript = requireDesktop('typescript');
  await init;
  const roots = new Set();
  roots.add('@playwright/mcp');
  for (const entry of harnessEntries.filter(entry => entry.isFile() && entry.name.endsWith('.mjs'))) {
    const source = await fs.readFile(path.join(harness, entry.name), 'utf8');
    for (const name of commonJsImports(source, typescript)) roots.add(name);
    const [imports] = parse(source);
    for (const specifier of imports.map(item => item.n).filter(Boolean)) {
      if (!specifier.startsWith('.') && !specifier.startsWith('node:')) {
        roots.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]);
      }
    }
  }
  // Adapters also import official modules by relative path (schedule and WAV
  // validation, for example). These are part of the shipped runtime too.
  for (const entry of (await fs.readdir(runtime, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.mjs'))) {
    const source = await fs.readFile(path.join(runtime, entry.name), 'utf8');
    for (const name of commonJsImports(source, typescript)) roots.add(name);
    const [imports] = parse(source);
    for (const specifier of imports.map(item => item.n).filter(name => name?.startsWith('.'))) {
      const resolved = path.resolve(runtime, specifier);
      const modules = path.join(harness, 'node_modules') + path.sep;
      if (!resolved.startsWith(modules)) continue;
      const parts = resolved.slice(modules.length).split(path.sep);
      roots.add(parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
    }
  }
  const { profileEntries } = await import(pathToFileURL(path.join(harness, 'profile.mjs')));
  for (const name of profilePackageNames(profileEntries(destination, destination, destination), path.join(harness, 'node_modules'))) roots.add(name);
  const adapterDependencies = Object.keys(JSON.parse(await fs.readFile(path.join(runtime, 'package.json'), 'utf8')).dependencies ?? {});
  for (const directory of new Set([...dependencyClosure(roots, harness), ...dependencyClosure(adapterDependencies, runtime)])) {
    const relative = path.relative(runtime, directory);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Harness dependency is outside runtime: ${directory}`);
    const target = path.join(destination, 'runtime', relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(directory, target, { recursive: true, dereference: true, filter: file =>
      file === directory || !['node_modules', '.bin', '.cache', '.DS_Store'].includes(path.basename(file)) &&
      !file.endsWith('.map') && !file.endsWith('.d.ts') });
    if (process.platform === 'darwin' && JSON.parse(await fs.readFile(path.join(target, 'package.json'), 'utf8')).name === 'node-pty') {
      // Harness runs under standalone Node, separately from Electron's PTY.
      // Repair only the staged helper's execute bit before hashing/signing.
      const { preparePty } = require('../ui/desktop/scripts/macos-package.cjs');
      preparePty(path.dirname(path.dirname(target)), process.arch);
    }
  }
  if (process.platform === 'win32') {
    await copy(path.join(runtime, 'tools/provenance.json'), path.join(destination, 'runtime/tools/provenance.json'));
    for (const binary of ['codebuddy-tools.exe', 'qwen-computer-use.exe']) {
      await copy(path.join(runtime, 'tools/bin', binary), path.join(destination, 'runtime/tools/bin', binary));
    }
  } else {
    const { macArtifactFiles } = require('../runtime/builtin-artifacts.mjs');
    for (const file of Object.values(macArtifactFiles))
      await copy(path.join(toolsDirectory, 'bin', file), path.join(destination, 'runtime/tools/bin', file));
    for (const file of ['artifacts.json', 'licenses'])
      await copy(path.join(toolsDirectory, file), path.join(destination, 'runtime/tools', file));
    await copy(path.join(toolsDirectory, options.toolsDirectory ? 'provenance.json' : 'provenance.macos.json'), path.join(destination, 'runtime/tools/provenance.json'));
  }
  await copy(path.join(repoRoot, 'ui/sdk/dist/generated/zod.gen.js'), path.join(destination, 'ui/sdk/dist/generated/zod.gen.js'));
  await fs.writeFile(path.join(destination, 'ui/sdk/package.json'), '{"type":"module"}\n');
  for (const [name, base] of [['yaml', 'ui/desktop'], ['zod', 'ui/sdk']]) {
    const require = createRequire(path.join(repoRoot, base, 'package.json'));
    await copy(path.dirname(require.resolve(`${name}/package.json`)), path.join(destination, 'ui/node_modules', name));
  }
  await copy(path.join(repoRoot, 'ui/desktop/package.json'), path.join(destination, 'ui/desktop/package.json'));
  const files = [];
  async function record(dir) {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await record(full);
      else files.push({ path: path.relative(destination, full).replaceAll('\\', '/'), sha256: crypto.createHash('sha256').update(await fs.readFile(full)).digest('hex') });
    }
  }
  await record(destination);
  const sourceDigest = crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
  await fs.writeFile(path.join(destination, 'manifest.json'), JSON.stringify({ schemaVersion: 1, engine: 'deepseek-harness', nodeVersion: process.versions.node, createdAt: new Date().toISOString(), sourceDigest, runtimeDependencies: [...roots].sort(), adapterDependencies, files }, null, 2));
  return { destination, sourceDigest, files: files.length };
}
module.exports = { stageHarness, distributionTarget, assertOfficeTarget };
if (require.main === module) {
  stageHarness(path.resolve(__dirname, '..'), path.resolve(process.argv[2])).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });
}
