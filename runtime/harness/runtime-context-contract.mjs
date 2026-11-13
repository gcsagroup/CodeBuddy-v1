import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { runtimeContextLoopPatch as patch } from './sdk-budget/runtime-context-patch.mjs';

// Agent-loop imports native tools, so their contracts must be installed first.
await import('./native-schedule-contract.mjs');
const url = import.meta.resolve(patch.name);
const source = readFileSync(new URL(url), 'utf8');
const version = JSON.parse(readFileSync(new URL('../package.json', url), 'utf8')).version;
if (version !== '0.2.1-alpha.2' || createHash('sha256').update(source).digest('hex') !== patch.hash)
  throw new Error('Review the pinned native runtime-context admission contract.');
const replacement = patch.transform(source);
let applied = false;
const hook = registerHooks({ load(loadedUrl, context, nextLoad) {
  const result = nextLoad(loadedUrl, context);
  if (loadedUrl !== url) return result;
  if (Buffer.from(result.source).toString('utf8') !== source)
    throw new Error('Native runtime-context source changed during loading.');
  applied = true;
  return { ...result, source: replacement };
} });
try {
  await import(url);
  if (!applied) throw new Error('Load the runtime-context contract before the native agent loop.');
} finally { hook.deregister(); }
