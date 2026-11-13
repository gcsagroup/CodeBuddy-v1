import defaults from './default-model.json' with { type: 'json' };
import { driverProvider, invalid, providerStatus, requireString } from './providers.mjs';

export const COMPACTION_FALLBACKS_KEY = 'compactionFallbacks';
export const COMPACTION_MODEL_KEY = 'compactionFallbackModel';

export function validateCompactionFallbackModel(value, providers, secret = false) {
  if (secret || !value || typeof value !== 'object' || !Object.hasOwn(value, 'model'))
    throw invalid('Compaction fallback must contain a model choice');
  if (value.model === null) return { model: null };
  const { providerId, modelId } = value.model ?? {};
  requireString(providerId, 'providerId');
  requireString(modelId, 'modelId');
  if (!providers.some(p => p.id === providerId && p.models.includes(modelId) && providerStatus(p).isConfigured))
    throw invalid('Configure the selected compaction connection first');
  return { model: { providerId, modelId } };
}

export function validateCompactionFallbacks(value, providers, secret = false) {
  if (secret || !Array.isArray(value)) throw invalid('Compaction fallbacks must be a non-secret array');
  const seen = new Set();
  for (const rule of value) {
    for (const route of [rule?.source, rule?.fallback]) {
      requireString(route?.providerId, 'providerId');
      requireString(route?.modelId, 'modelId');
      if (!providers.some(p => p.id === route.providerId && p.models.includes(route.modelId) && providerStatus(p).isConfigured))
        throw invalid('Configure the selected compaction connection first');
    }
    const key = JSON.stringify([rule.source.providerId, rule.source.modelId]);
    if (seen.has(key) || rule.source.providerId === rule.fallback.providerId && rule.source.modelId === rule.fallback.modelId)
      throw invalid('Compaction fallbacks require unique sources and a different fallback');
    seen.add(key);
  }
  return structuredClone(value);
}

// Deployment defaults only select existing configured connections. They never
// create a connection, restore an old adapter or send a discovery request.
export function resolveCompactionFallbacks(config, providers, selected) {
  if (!selected) return [];
  const choices = [];
  const user = config[COMPACTION_MODEL_KEY];
  const legacy = config[COMPACTION_FALLBACKS_KEY]?.value;
  if (user) {
    if (user.value?.model) choices.push(user.value.model);
  } else if (Array.isArray(legacy)) {
    // Keep explicitly disabled and source-specific legacy settings until the
    // user saves the new global choice. No historical configuration is rewritten.
    const rule = legacy.find(rule => rule.source?.providerId === selected.provider.id && rule.source?.modelId === selected.model);
    if (!rule) return [];
    choices.push(rule.fallback);
  }
  const preset = defaults.compactionFallback;
  let fixed;
  if (preset) {
    const candidates = providers.filter(p => p.apiUrl?.replace(/\/$/, '') === preset.baseUrl && providerStatus(p).isConfigured);
    for (const modelId of preset.modelIds) {
      let matches = candidates.filter(p => p.models.includes(modelId));
      // Older profiles at the same configured endpoint may predate Flash in
      // their saved model list. Resolve this fixed deployment model lazily too.
      if (!matches.length && candidates.length === 1) matches = candidates;
      if (matches.length !== 1) continue;
      fixed = { providerId: matches[0].id, modelId };
      choices.push(fixed);
      break;
    }
  }
  const seen = new Set([JSON.stringify([selected.provider.id, selected.model])]);
  const fallbacks = [];
  for (const route of choices) {
    const key = JSON.stringify([route?.providerId, route?.modelId]);
    if (seen.has(key)) continue;
    seen.add(key);
    const provider = providers.find(p => p.id === route?.providerId && (route === fixed || p.models.includes(route?.modelId)) && providerStatus(p).isConfigured);
    if (!provider) continue;
    fallbacks.push({ resolveFallback: async () => ({ provider: await driverProvider(provider, route.modelId), model: route.modelId }) });
  }
  return fallbacks.length ? [{ source: selected, fallbacks }] : [];
}
