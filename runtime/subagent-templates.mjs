import { invalid, driverProvider } from './providers.mjs';

export const SUBAGENT_TEMPLATES_KEY = 'subagentTemplates';
const roles = ['explorer', 'browser', 'generic'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function modelChoice(selection, providers, label) {
  if (selection == null) return null;
  if (!record(selection) || Object.keys(selection).some(key => !['providerId', 'modelId'].includes(key)) ||
      ['providerId', 'modelId'].some(key => typeof selection[key] !== 'string' || !selection[key].trim() || selection[key].length > 256))
    throw invalid(`Invalid ${label} model selection`);
  const normalized = { providerId: selection.providerId.trim(), modelId: selection.modelId.trim() };
  if (providers && !providers.some(provider => provider.id === normalized.providerId))
    throw invalid(`The selected ${label} provider is unavailable`);
  return normalized;
}

// This stores user choices, never native session ids, history or credentials.
export function validateSubagentTemplates(value, providers, isSecret = false) {
  if (isSecret || !record(value) || value.version !== 1 || !record(value.models) ||
      Object.keys(value).some(key => !['version', 'models', 'custom'].includes(key)) ||
      Object.keys(value.models).some(key => !roles.includes(key)))
    throw invalid('Invalid subagent template settings');
  const models = {};
  for (const role of roles) {
    models[role] = modelChoice(value.models[role], providers, role);
  }
  // Optional additive field keeps existing model-only settings readable.
  if (value.custom === undefined) return { version: 1, models };
  if (!Array.isArray(value.custom) || value.custom.length > 16) throw invalid('最多保存 16 个自定义子 Agent。');
  const ids = new Set(), names = new Set(roles);
  const custom = value.custom.map(template => {
    if (!record(template) || Object.keys(template).some(key => !['id', 'name', 'description', 'prompt', 'model', 'tools'].includes(key)) ||
        typeof template.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(template.id) || ids.has(template.id))
      throw invalid('自定义子 Agent 的标识无效或重复。');
    for (const [key, limit] of [['name', 80], ['description', 512], ['prompt', 8000]]) {
      if (typeof template[key] !== 'string' || !template[key].trim() || template[key].length > limit)
        throw invalid('请填写名称、适用场景和职责说明，并检查长度限制。');
    }
    const name = template.name.trim();
    if (names.has(name.toLowerCase())) throw invalid('子 Agent 名称不能重复，也不能与默认模板重名。');
    if (template.tools != null && !['read-only', 'none'].includes(template.tools))
      throw invalid('请选择继承工具、仅阅读与检索，或不使用工具。');
    ids.add(template.id); names.add(name.toLowerCase());
    return { id: template.id, name, description: template.description.trim(), prompt: template.prompt.trim(),
      model: modelChoice(template.model, providers, name), tools: template.tools ?? null };
  });
  return { version: 1, models, custom };
}

async function resolveModel(selected, providers, resolveCapability, label) {
  if (!selected) return null;
  const provider = providers.find(candidate => candidate.id === selected.providerId);
  if (!provider) return { error: `The selected ${label} model connection is unavailable. Update subagent settings.` };
  try {
    const configured = await driverProvider(provider, selected.modelId);
    const capability = await resolveCapability?.(selected.providerId, selected.modelId);
    if (capability?.imageInput === 'supported') configured.inputModalities = ['text', 'image'];
    return { provider: configured, model: selected.modelId };
  } catch { return { error: `The selected ${label} model connection could not be loaded. Update subagent settings.` }; }
}

export async function resolveCustomSubagentTemplates(config, providers, resolveCapability) {
  const settings = validateSubagentTemplates(config?.[SUBAGENT_TEMPLATES_KEY]?.value ?? { version: 1, models: {} });
  return Promise.all((settings.custom ?? []).map(async template => ({ ...template,
    model: await resolveModel(template.model, providers, resolveCapability, template.name),
  })));
}

export async function resolveSubagentModels(config, providers, resolveCapability) {
  const settings = validateSubagentTemplates(config?.[SUBAGENT_TEMPLATES_KEY]?.value ?? { version: 1, models: {} });
  const result = {};
  for (const role of roles) {
    const selected = settings.models[role];
    if (!selected) continue;
    // A deleted connection affects new children using it, not ordinary chat or
    // an existing native child whose route and history are already resolved.
    result[role] = await resolveModel(selected, providers, resolveCapability, role);
  }
  return result;
}
