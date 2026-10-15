const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { dependencyClosure, commonJsImports } = require('./harness-dependencies.cjs');

async function stageHarness(repoRoot, destination) {
  // Each build uses a fresh stage. Never delete a prior candidate or profile.
  await fs.mkdir(destination, { recursive: false });
  if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) < 24)
    throw new Error('Stage with the existing Windows Node 24+ runtime');
  const runtime = path.join(repoRoot, 'runtime');
  const copy = async (source, target) => {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(source, target, { recursive: true, dereference: true, filter: file => !['.bin', '.cache', '.DS_Store'].includes(path.basename(file)) });
  };
  await copy(process.execPath, path.join(destination, 'node/node.exe'));
  await copy(path.join(path.dirname(process.execPath), 'LICENSE'), path.join(destination, 'node/LICENSE'));
  for (const entry of await fs.readdir(runtime, { withFileTypes: true })) {
    if (entry.isFile() && /\.(mjs|json)$/.test(entry.name) || entry.name === 'assets') {
      await copy(path.join(runtime, entry.name), path.join(destination, 'runtime', entry.name));
    }
  }
  const harness = path.join(runtime, 'harness');
  const harnessEntries = await fs.readdir(harness, { withFileTypes: true });
  for (const entry of harnessEntries) {
    if (entry.isFile() && /\.(mjs|json)$/.test(entry.name)) {
      await copy(path.join(runtime, 'harness', entry.name), path.join(destination, 'runtime/harness', entry.name));
    }
  }
  const requireDesktop = createRequire(path.join(repoRoot, 'ui/desktop/package.json'));
  const { init, parse } = requireDesktop('es-module-lexer');
  const typescript = requireDesktop('typescript');
  await init;
  const roots = new Set();
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
  for (const entry of profileEntries(destination, destination, destination)) {
    let directory = path.dirname(fileURLToPath(entry.name));
    if (!directory.startsWith(path.join(harness, 'node_modules') + path.sep)) continue;
    while (!await fs.stat(path.join(directory, 'package.json')).catch(() => null)) directory = path.dirname(directory);
    roots.add(JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8')).name);
  }
  const adapterDependencies = Object.keys(JSON.parse(await fs.readFile(path.join(runtime, 'package.json'), 'utf8')).dependencies ?? {});
  for (const directory of new Set([...dependencyClosure(roots, harness), ...dependencyClosure(adapterDependencies, runtime)])) {
    const relative = path.relative(runtime, directory);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Harness dependency is outside runtime: ${directory}`);
    const target = path.join(destination, 'runtime', relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(directory, target, { recursive: true, dereference: true, filter: file =>
      file === directory || !['node_modules', '.bin', '.cache', '.DS_Store'].includes(path.basename(file)) &&
      !file.endsWith('.map') && !file.endsWith('.d.ts') });
  }
  for (const binary of ['goose-0a286375/goose.exe', 'qwen-computer-use.exe']) {
    await copy(path.join(runtime, 'tools/bin', binary), path.join(destination, 'runtime/tools/bin', binary));
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
module.exports = { stageHarness };
if (require.main === module) {
  stageHarness(path.resolve(__dirname, '..'), path.resolve(process.argv[2])).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });
}
