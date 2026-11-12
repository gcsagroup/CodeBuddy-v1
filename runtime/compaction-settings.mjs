import defaults from './default-model.json' with { type: 'json' };
import { driverProvider, invalid, providerStatus, requireString } from './providers.mjs';

export const COMPACTION_FALLBACKS_KEY = 'compactionFallbacks';

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
  let rules = config[COMPACTION_FALLBACKS_KEY]?.value;
  if (rules === undefined) {
    rules = [];
    const preset = defaults.compactionFallback;
    if (preset) {
      const candidates = providers.filter(p => p.apiUrl?.replace(/\/$/, '') === preset.baseUrl && providerStatus(p).isConfigured);
      for (const modelId of preset.modelIds) {
        const matches = candidates.filter(p => p.models.includes(modelId));
        if (matches.length !== 1) continue;
        for (const source of providers.filter(p => p.models.includes(defaults.modelId) && providerStatus(p).isConfigured))
          rules.push({ source: { providerId: source.id, modelId: defaults.modelId }, fallback: { providerId: matches[0].id, modelId } });
        break;
      }
    }
  }
  const resolved = [];
  for (const rule of rules) {
    if (rule.source.providerId !== selected.provider.id || rule.source.modelId !== selected.model) continue;
    const source = providers.find(p => p.id === rule.source.providerId && p.models.includes(rule.source.modelId));
    const fallback = providers.find(p => p.id === rule.fallback.providerId && p.models.includes(rule.fallback.modelId));
    // Removing a fallback must not make otherwise healthy ordinary chat fail.
    if (!source || !fallback || !providerStatus(fallback).isConfigured) continue;
    resolved.push({ source: selected, resolveFallback: async () => ({
      provider: await driverProvider(fallback, rule.fallback.modelId), model: rule.fallback.modelId,
    }) });
  }
  return resolved;
}
