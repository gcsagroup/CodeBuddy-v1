import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { skillCatalogPatch as patch } from './sdk-budget/skill-catalog-patch.mjs';

// Install after the tool/session contracts and before any native skill consumer.
const url = import.meta.resolve(patch.name);
const source = readFileSync(new URL(url), 'utf8');
const version = JSON.parse(readFileSync(new URL('../package.json', url), 'utf8')).version;
const registrySource = readFileSync(new URL(import.meta.resolve('@deepseek-ai/dsh-skill')), 'utf8');
if (createHash('sha256').update(registrySource).digest('hex') !== '4b88621be4e7ff09b05c175fc6dcb67e77a22e5c5570e3aa603338b2937ea791')
  throw new Error('Review the pinned skill registry snapshot/collect revision contract.');
if (version !== '0.2.1-alpha.2' || createHash('sha256').update(source).digest('hex') !== patch.hash)
  throw new Error('Review the pinned native skill-catalog presentation contract.');
const replacement = patch.transform(source);
let applied = false;
const hook = registerHooks({ load(loadedUrl, context, nextLoad) {
  const result = nextLoad(loadedUrl, context);
  if (loadedUrl !== url) return result;
  if (Buffer.from(result.source).toString('utf8') !== source)
    throw new Error('Native skill-catalog source changed during loading.');
  applied = true;
  return { ...result, source: replacement };
} });
try {
  await import(url);
  if (!applied) throw new Error('Load the skill-catalog contract before native skill consumers.');
} finally { hook.deregister(); }
