import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { runtimeContextLoopPatch as patch } from './sdk-budget/runtime-context-patch.mjs';
import { patchSteeringLoop, steeringJobsPatch } from './steering-patch.mjs';

// Agent-loop imports native tools, so their contracts must be installed first.
await import('./native-schedule-contract.mjs');
const contracts = [
  { ...patch, transform: source => patchSteeringLoop(patch.transform(source)) },
  steeringJobsPatch,
].map(contract => {
  const url = import.meta.resolve(contract.name);
  const source = readFileSync(new URL(url), 'utf8');
  const version = JSON.parse(readFileSync(new URL('../package.json', url), 'utf8')).version;
  if (version !== '0.2.1-alpha.2' || createHash('sha256').update(source).digest('hex') !== contract.hash)
    throw new Error(`Review the pinned native admission contract: ${contract.name}.`);
  return { ...contract, url, source, replacement: contract.transform(source), applied: false };
});
const hook = registerHooks({ load(loadedUrl, context, nextLoad) {
  const result = nextLoad(loadedUrl, context);
  const contract = contracts.find(item => item.url === loadedUrl);
  if (!contract) return result;
  if (Buffer.from(result.source).toString('utf8') !== contract.source)
    throw new Error('Native runtime-context source changed during loading.');
  contract.applied = true;
  return { ...result, source: contract.replacement };
} });
try {
  for (const contract of contracts) {
    await import(contract.url);
    if (!contract.applied) throw new Error(`Load the native admission contract before ${contract.name}.`);
  }
} finally { hook.deregister(); }
