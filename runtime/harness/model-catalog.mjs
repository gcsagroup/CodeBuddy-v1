import { Context } from '@deepseek-ai/cordis';
import { builtinProviders, getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';

// Metadata discovery can run before the execution Host. It must share the same
// native adapter/LLM identities, with their compatibility contract already loaded.
await import('./sdk-budget-contract.mjs');
const { default: Llm } = await import('@deepseek-ai/dsh-llm');
const pi = await import('@deepseek-ai/dsh-llm-pi-ai');

// Read the installed adapter's public schema, not another host-owned limit.
export const DEFAULT_CONTEXT_WINDOW = pi.Config.dict.providers.inner.dict.defaultContextWindow.meta.default;

function catalogBase(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined;
    url.pathname = url.pathname.replace(/\/$/, '').replace(/\/v1$/, '') || '/';
    return url.href;
  } catch { return undefined; }
}

const providerBases = builtinProviders().filter(provider => typeof provider.baseUrl === 'string')
  .map(provider => [provider.id, catalogBase(provider.baseUrl)]);

export function catalogProviderForEndpoint(baseUrl) {
  const base = catalogBase(baseUrl);
  if (!base) return undefined;
  const matches = providerBases.filter(([, candidate]) => candidate === base);
  return matches.length === 1 ? matches[0][0] : undefined;
}

export function catalogModelIds(provider) {
  return provider ? getBuiltinModels(provider).map(model => model.id) : [];
}

export function catalogThinkingProfile(provider, id) {
  const model = getBuiltinModels(provider).find(item => item.id === id);
  if (!model) return {};
  if (!model.reasoning) return { reasoningEfforts: false };
  return {
    reasoningEfforts: Object.fromEntries(getSupportedThinkingLevels(model).map(level =>
      [level, model.thinkingLevelMap?.[level] ?? (level === 'off' ? 'none' : level)])),
    compat: { thinkingFormat: 'openai', supportsReasoningEffort: true, supportsDeveloperRole: false },
  };
}

// Metadata only: no agent loop, sessions, storage, credentials or execution host.
export async function catalogModels(provider) {
  const ctx = new Context();
  const llm = ctx.plugin(Llm);
  await llm;
  const adapter = ctx.plugin(pi, { providers: {} });
  try {
    await adapter;
    return await ctx.llm.discoverModels('llm-pi-ai', { provider });
  } finally {
    await adapter.dispose();
    await llm.dispose();
  }
}
