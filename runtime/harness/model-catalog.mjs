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
export const DEFAULT_OUTPUT_TOKENS = pi.Config.dict.providers.inner.dict.defaultMaxTokens.meta.default;

// Releases can precede the pinned SDK catalog. Exact provider/model records
// supplement missing entries only; SDK entries and live service metadata win.
// Verified 2026-11-19: https://developers.openai.com/api/docs/models/gpt-6.2-astra
// https://developers.openai.com/api/docs/models/gpt-6.2-sol
// The official Responses validator confirms low/medium/high/xhigh/max for both.
const catalogSupplements = {
  openai: ['astra', 'sol'].map(variant => ({
    id: `gpt-6.2-${variant}`,
    name: `GPT-6.2 ${variant === 'astra' ? 'Astra' : 'Sol'}`,
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    inputModalities: ['text', 'image'],
    reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  })),
};

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

// An official compatibility API is another transport for the same provider.
// Match complete endpoint identities; never infer the provider from model names
// or strip arbitrary gateway paths. See https://ai.google.dev/gemini-api/docs/openai.
const compatibilityBases = new Map([
  ['https://generativelanguage.googleapis.com/v1beta/openai', 'google'],
  ['https://generativelanguage.googleapis.com/v1/openai', 'google'],
]);

export function catalogProviderForEndpoint(baseUrl) {
  const base = catalogBase(baseUrl);
  if (!base) return undefined;
  const compatibilityProvider = compatibilityBases.get(base.replace(/\/$/, ''));
  if (compatibilityProvider) return compatibilityProvider;
  const matches = providerBases.filter(([, candidate]) => candidate === base);
  return matches.length === 1 ? matches[0][0] : undefined;
}

export function catalogModelId(provider, id) {
  // Google's compatibility inventory returns resource names, whereas the SDK
  // indexes bare IDs. Only catalog lookups are normalized: saved preferences,
  // service declarations and outgoing model IDs keep their original identity.
  return provider === 'google' && typeof id === 'string' && id.startsWith('models/')
    ? id.slice('models/'.length) : id;
}

export function catalogModelIds(provider) {
  return provider ? [...new Set([...getBuiltinModels(provider), ...(catalogSupplements[provider] ?? [])].map(model => model.id))] : [];
}

export function catalogThinkingProfile(provider, id) {
  id = catalogModelId(provider, id);
  const model = getBuiltinModels(provider).find(item => item.id === id);
  if (!model) {
    const supplement = catalogSupplements[provider]?.find(item => item.id === id);
    return supplement ? {
      reasoningEfforts: { ...supplement.reasoningEfforts },
      compat: { thinkingFormat: 'openai', supportsReasoningEffort: true, supportsDeveloperRole: false },
    } : {};
  }
  if (!model.reasoning) return { reasoningEfforts: false };
  // The Google native adapter's generic off slot is a local budget convention,
  // not proof its compatibility API accepts reasoning_effort=none (e.g. Pro).
  // Only explicit per-model mappings establish selectable off capabilities.
  const levels = getSupportedThinkingLevels(model).filter(level =>
    !(provider === 'google' && !model.thinkingLevelMap && level === 'off'));
  return {
    reasoningEfforts: Object.fromEntries(levels.map(level =>
      [level, provider === 'google' ? (level === 'off' ? 'none' : level)
        : model.thinkingLevelMap?.[level] ?? (level === 'off' ? 'none' : level)])),
    thinkingSource: 'catalog',
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
    const models = await ctx.llm.discoverModels('llm-pi-ai', { provider });
    return [...models, ...(catalogSupplements[provider] ?? [])
      .filter(model => !models.some(existing => existing.id === model.id))
      .map(({ reasoningEfforts: _reasoning, ...model }) => ({ ...model, inputModalities: [...model.inputModalities] }))];
  } finally {
    await adapter.dispose();
    await llm.dispose();
  }
}
