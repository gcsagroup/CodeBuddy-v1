import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { llmPatch } from './sdk-budget/llm-patch.mjs';
import { adapterPatch } from './sdk-budget/adapter-patch.mjs';
import { compactionPatch } from './sdk-budget/compaction-patch.mjs';
import { retryPatch } from './sdk-budget/retry-patch.mjs';
import { runtimeContextSessionPatch, runtimeContextMeterPatch, runtimeContextImageOffloadPatch } from './sdk-budget/runtime-context-patch.mjs';

// The adapter's estimator and 4096-token reservation belong to this exact Pi
// release. Do not silently combine the shim with independently upgraded helpers.
const helperPins = [
  ['@earendil-works/pi-ai/api/simple-options', '9b3cc0ae6daa86fdc050bc0cb0f3f986401e64ccddbde6757183c9f8ad411be2'],
  ['@earendil-works/pi-ai/utils/estimate', 'b5b606011ab0dce2a5db309dd812c9b8ddd0bbcbc9416de699fb9cd087cc84d6'],
  ['@earendil-works/pi-ai/utils/transcript', '4c772c6691be0c5b4c308a09e3eeaa4d965b59e39652442b3aef0600ffb5fccb'],
  ['@earendil-works/pi-ai/utils/overflow', '85570a78e9ba3e0322fe1b3f14c991b6a439b1d3eb89af306e2e7e9ade3d53b4'],
  ['@earendil-works/pi-ai/api/openai-responses', '8de25051531f131c4ae3d730f371fa0e15559ed7f865765a744c64d5edd2e067'],
];
for (const [name, hash] of helperPins) {
  const source = readFileSync(new URL(import.meta.resolve(name)), 'utf8');
  if (createHash('sha256').update(source).digest('hex') !== hash)
    throw new Error(`Review the pinned Pi request-fit helper: ${name}.`);
}
const piVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.resolve(helperPins[0][0])), 'utf8')).version;
if (piVersion !== '1.2.0') throw new Error('Review the SDK request-fit contract for the installed Pi version.');

// Register every seam before importing any SDK module: their dependencies share
// native module identities. A loaded or upgraded module must fail explicitly.
const patches = [llmPatch, adapterPatch, compactionPatch, retryPatch,
  runtimeContextSessionPatch, runtimeContextMeterPatch, runtimeContextImageOffloadPatch].map(patch => {
  const url = import.meta.resolve(patch.name);
  const source = readFileSync(new URL(url), 'utf8');
  const version = JSON.parse(readFileSync(new URL('../package.json', url), 'utf8')).version;
  if (version !== '0.2.1-alpha.2')
    throw new Error(`Review the pinned SDK version for ${patch.name}.`);
  if (createHash('sha256').update(source).digest('hex') !== patch.hash)
    throw new Error(`Review the pinned SDK request-fit contract for ${patch.name}.`);
  return { ...patch, url, source, replacement: patch.transform(source), applied: false };
});
// Reuse the very same serializer and reasoning options for measurement and inference.
const completionUrl = import.meta.resolve('@earendil-works/pi-ai/api/openai-completions');
const completionSource = readFileSync(new URL(completionUrl), 'utf8');
if (createHash('sha256').update(completionSource).digest('hex') !== '5a79cc5aa41dee180692695e65771720d1ea556e9a978649dc2040278be51753')
  throw new Error('Review the pinned chat tokenizer projection.');
const completionProjection = completionSource
  .replace('export const streamSimple = (model, context, options) => {', 'const simpleOptions = (model, context, options) => {')
  .replace('return stream(model, context, {\n        ...base,', 'return {\n        ...base,')
  .replace('thinkingBudgets: options?.thinkingBudgets,\n    });\n};', `thinkingBudgets: options?.thinkingBudgets,
    };
};
export const streamSimple = (model, context, options) => stream(model, context, simpleOptions(model, context, options));
export const countPayload = (model, context, options) => buildParams(model,
    resolveTranscript(context, getCompat(model).supportsMidConvoSystemMessages), simpleOptions(model, context, options));`);
patches.unshift({ name: 'pi-ai chat serializer', url: completionUrl, source: completionSource, replacement: completionProjection, applied: false });
const hook = registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    const patch = patches.find(item => item.url === url);
    if (patch === undefined) return loaded;
    if (Buffer.from(loaded.source).toString('utf8') !== patch.source)
      throw new Error(`Native source changed during request-fit contract loading: ${patch.name}`);
    patch.applied = true;
    return { ...loaded, source: patch.replacement };
  },
});
try {
  for (const patch of patches) {
    await import(patch.url);
    if (!patch.applied) throw new Error(`Load the SDK request-fit contract before ${patch.name}.`);
  }
} finally {
  hook.deregister();
}
