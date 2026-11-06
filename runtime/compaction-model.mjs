import { invalid, driverProvider, providerStatus } from './providers.mjs';

export const COMPACTION_MODEL_KEY = 'compactionModel';

export function validateCompactionModel(value, providers, isSecret = false) {
  if (isSecret) throw invalid('Compaction model selection cannot contain credentials');
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['providerId', 'modelId'].includes(key)) ||
      ['providerId', 'modelId'].some(key => typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 256))
    throw invalid('Select a configured compaction model or follow the conversation model');
  const choice = { providerId: value.providerId.trim(), modelId: value.modelId.trim() };
  if (providers && !providers.some(provider => provider.id === choice.providerId &&
      providerStatus(provider).isConfigured && provider.models.includes(choice.modelId)))
    throw invalid('The selected compaction model connection or model is unavailable');
  return choice;
}

// A stale auxiliary choice must fail compression, not unrelated conversation requests.
export async function resolveCompactionModel(config, providers, resolveCapability) {
  try {
    const choice = validateCompactionModel(config?.[COMPACTION_MODEL_KEY]?.value);
    if (!choice) return null;
    validateCompactionModel(choice, providers);
    const provider = await driverProvider(providers.find(item => item.id === choice.providerId), choice.modelId);
    const capability = await resolveCapability?.(choice);
    if (capability?.imageInput === 'supported') provider.inputModalities = ['text', 'image'];
    return { provider, model: choice.modelId };
  } catch (error) {
    return { error: `Compaction model unavailable. Update Model and runtime settings: ${error.message}` };
  }
}
