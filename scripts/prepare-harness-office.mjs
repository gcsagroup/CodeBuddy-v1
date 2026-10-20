import { registerHooks, createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readdir, readFile, stat, rename, rmdir } from 'node:fs/promises';
import { distributionTarget } from './stage-harness-distribution.cjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireHarness = createRequire(join(root, 'runtime/harness/package.json'));
const dependencyApi = pathToFileURL(requireHarness.resolve('@deepseek-ai/dsh-tool-workspace-dependencies')).href;
// Resolve only the official builder's Harness API into the existing pinned host.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-tool-workspace-dependencies') {
    return { url: dependencyApi, shortCircuit: true };
  }
  return next(specifier, context);
} });
const target = distributionTarget().office;
if (Number(process.versions.node.split('.')[0]) < 24)
  throw Error('Use the existing native Node 24+ runtime for this payload');
const output = join(root, 'runtime/office-assets');
for (const name of ['py', 'office']) {
  if (await stat(join(root, 'runtime', name)).catch(error => { if (error.code !== 'ENOENT') throw error; }))
    throw Error(`Existing runtime/${name} is preserved; verify before preparing a replacement`);
}
try { if ((await readdir(output)).length) throw Error('Office payload already exists; preserve it and verify before preparing a replacement'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const { preparePrimaryRuntime, smokePrimaryRuntime } = await import('./office-builder/upstream/prepare.ts');
const { version } = JSON.parse(await readFile(join(root, 'ui/desktop/package.json'), 'utf8'));
console.log('Preparing the official pinned Python-only Office payload; system Python is unchanged.');
await preparePrimaryRuntime({ target, output,
  cache: join(root, 'target/harness-office-downloads'), version, pythonOnly: true,
  skillSource: join(dirname(requireHarness.resolve('@deepseek-ai/dsh-skill-office/package.json')), 'assets'),
});
smokePrimaryRuntime(join(output, 'primary-runtime'));
// Keep upstream payload contents intact while shortening Squirrel install paths.
await rename(join(output, 'primary-runtime'), join(root, 'runtime/py'));
await rename(join(output, 'office-skills'), join(root, 'runtime/office'));
await rmdir(output);
console.log(JSON.stringify({ passed: true, python: join(root, 'runtime/py'), skills: join(root, 'runtime/office'), systemPythonChanged: false }));
