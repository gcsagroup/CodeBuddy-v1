const fs = require('node:fs');
const path = require('node:path');
const { isBuiltin } = require('node:module');
const { fileURLToPath } = require('node:url');

function profilePackageNames(entries, modulesDirectory) {
  // import.meta.resolve follows a shared node_modules junction in worktrees.
  // Compare real locations, then preserve the logical package layout on copy.
  const modules = fs.realpathSync(modulesDirectory);
  const names = new Set();
  for (const entry of entries) {
    let directory = fs.realpathSync(path.dirname(fileURLToPath(entry.name)));
    const relative = path.relative(modules, directory);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
    while (!fs.existsSync(path.join(directory, 'package.json'))) {
      if (directory === modules) throw new Error(`Profile entry has no package manifest: ${entry.name}`);
      directory = path.dirname(directory);
    }
    names.add(JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).name);
  }
  return names;
}

function commonJsImports(source, typescript) {
  const names = new Set();
  const tree = typescript.createSourceFile('runtime.mjs', source, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.JS);
  function visit(node) {
    if (typescript.isCallExpression(node) && typescript.isIdentifier(node.expression) && node.expression.text === 'require') {
      const argument = node.arguments[0];
      if (!argument || !typescript.isStringLiteralLike(argument)) throw new Error('Dynamic require needs an explicit packaging dependency');
      const name = argument.text;
      if (!isBuiltin(name) && !name.startsWith('.') && !path.isAbsolute(name)) names.add(name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]);
    }
    typescript.forEachChild(node, visit);
  }
  visit(tree);
  return names;
}

function resolvePackage(name, from) {
  let directory = from;
  for (;;) {
    const manifest = path.join(directory, 'node_modules', name, 'package.json');
    if (fs.existsSync(manifest)) return path.dirname(manifest);
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Missing runtime dependency ${name} from ${from}`);
    directory = parent;
  }
}

// Keep Node's existing nested version layout; include runtime and peer edges,
// never a package's development dependencies or unrelated CLI plugins.
function dependencyClosure(names, from) {
  const directories = new Set();
  function visit(directory) {
    if (directories.has(directory)) return;
    directories.add(directory);
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const dependencies = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ]);
    for (const name of dependencies) {
      let resolved;
      try { resolved = resolvePackage(name, directory); }
      catch (error) {
        if (pkg.optionalDependencies?.[name] || pkg.peerDependenciesMeta?.[name]?.optional) continue;
        throw error;
      }
      visit(resolved);
    }
  }
  for (const name of names) visit(resolvePackage(name, from));
  return [...directories];
}

module.exports = { dependencyClosure, commonJsImports, profilePackageNames };
