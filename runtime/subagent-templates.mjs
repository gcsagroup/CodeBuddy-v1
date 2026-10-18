import { invalid, driverProvider } from './providers.mjs';

export const SUBAGENT_TEMPLATES_KEY = 'subagentTemplates';
const roles = ['explorer', 'browser', 'generic'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// This stores user choices, never native session ids, history or credentials.
export function validateSubagentTemplates(value, providers, isSecret = false) {
  if (isSecret || !record(value) || value.version !== 1 || !record(value.models) ||
      Object.keys(value).some(key => !['version', 'models'].includes(key)) ||
      Object.keys(value.models).some(key => !roles.includes(key)))
    throw invalid('Invalid subagent template settings');
  const models = {};
  for (const role of roles) {
    const selection = value.models[role] ?? null;
    if (selection !== null && (!record(selection) ||
        Object.keys(selection).some(key => !['providerId', 'modelId'].includes(key)) ||
        ['providerId', 'modelId'].some(key => typeof selection[key] !== 'string' || !selection[key].trim() || selection[key].length > 256)))
      throw invalid(`Invalid ${role} model selection`);
    if (selection && providers && !providers.some(provider => provider.id === selection.providerId))
      throw invalid(`The selected ${role} provider is unavailable`);
    models[role] = selection ? { providerId: selection.providerId.trim(), modelId: selection.modelId.trim() } : null;
  }
  return { version: 1, models };
}

export async function resolveSubagentModels(config, providers, resolveCapability) {
  const settings = validateSubagentTemplates(config?.[SUBAGENT_TEMPLATES_KEY]?.value ?? { version: 1, models: {} });
  const result = {};
  for (const role of roles) {
    const selected = settings.models[role];
    if (!selected) continue;
    const provider = providers.find(candidate => candidate.id === selected.providerId);
    // A deleted connection affects new children using it, not ordinary chat or
    // an existing native child whose route and history are already resolved.
    if (!provider) { result[role] = { error: `The selected ${role} model connection is unavailable. Update subagent settings.` }; continue; }
    try {
      const configured = await driverProvider(provider, selected.modelId);
      const capability = await resolveCapability?.(selected.providerId, selected.modelId);
      if (capability?.imageInput === 'supported') configured.inputModalities = ['text', 'image'];
      result[role] = { provider: configured, model: selected.modelId };
    }
    catch { result[role] = { error: `The selected ${role} model connection could not be loaded. Update subagent settings.` }; }
  }
  return result;
}
