import type {
  CanonicalModelInfoDto,
  CustomProviderCreateRequest_unstable,
  CustomProviderReadResponse_unstable,
  CustomProviderDiscoverModelsRequest_unstable,
  ProviderInventoryModelDto,
  ProviderSecretDto,
  ProviderTemplateCatalogEntryDto,
  ProviderTemplateDto,
} from '@aaif/goose-sdk';
import type {
  ProviderDetails,
  ThinkingEffort,
  ModelThinkingSettings,
  UpdateCustomProviderRequest,
} from '../types/providers';
import { getAcpClient } from './acpConnection';
import { readPreferences, savePreferences } from './preferences';

export type { CanonicalModelInfoDto, ProviderSecretDto };

function updateRequestToCreate(
  request: UpdateCustomProviderRequest
): CustomProviderCreateRequest_unstable {
  return {
    engine: request.engine,
    displayName: request.display_name,
    apiUrl: request.api_url,
    apiKey: request.api_key || null,
    models: request.models,
    supportsStreaming: request.supports_streaming ?? null,
    headers: request.headers ?? undefined,
    requiresAuth: request.requires_auth ?? true,
    catalogProviderId: request.catalog_provider_id ?? null,
    basePath: request.base_path ?? null,
    preservesThinking: request.preserves_thinking ?? null,
  };
}

export async function acpListProviderDetails(): Promise<ProviderDetails[]> {
  const client = await getAcpClient();
  const { entries } = await client.goose.providersList_unstable({});
  return entries.map((entry) => ({
    category: entry.category,
    name: entry.providerId,
    is_configured: entry.configured,
    provider_type: entry.providerType as ProviderDetails['provider_type'],
    metadata: {
      name: entry.providerId,
      display_name: entry.providerName,
      description: entry.description,
      default_model: entry.defaultModel,
      model_doc_link: '',
      model_selection_hint: entry.modelSelectionHint ?? null,
      config_keys: entry.configKeys.map((key) => {
        return {
          name: key.name,
          required: key.required,
          secret: key.secret,
          default: key.default ?? null,
          oauth_flow: key.oauthFlow ?? false,
          device_code_flow: key.deviceCodeFlow ?? false,
          primary: key.primary ?? false,
          credential_validation_supported: key.credentialValidationSupported,
          credential_validation_unavailable_reason:
            key.credentialValidationUnavailableReason || null,
        };
      }),
      known_models: entry.models.map((model) => ({
        name: model.id,
        context_limit: model.contextLimit ?? 0,
        reasoning: model.reasoning ?? undefined,
      })),
      setup_steps: entry.setupSteps,
    },
  }));
}

export async function acpRefreshProviderModels(providerId: string): Promise<void> {
  const client = await getAcpClient();
  const result = await client.goose.providersInventoryRefresh_unstable({
    providerIds: [providerId],
  });
  if (!result.started.includes(providerId)) throw new Error('Model refresh did not complete');
}

export async function acpListProviderModels(providerId: string) {
  const client = await getAcpClient();
  const [{ models: liveModelIds }, { entries }] = await Promise.all([
    client.goose.providersSupportedModelsList_unstable({ providerId }),
    client.goose.providersList_unstable({ providerIds: [providerId] }),
  ]);
  const inventoryModels = entries.find((entry) => entry.providerId === providerId)?.models ?? [];
  const inventoryById = new Map(inventoryModels.map((model) => [model.id, model]));
  const models: ProviderInventoryModelDto[] = [];
  const seen = new Set<string>();

  for (const rawModelId of liveModelIds) {
    const modelId = rawModelId.trim();
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    models.push(inventoryById.get(modelId) ?? { id: modelId, name: modelId });
  }

  return models;
}

export async function acpListProviderCatalogEntries(
  format?: string
): Promise<ProviderTemplateCatalogEntryDto[]> {
  const client = await getAcpClient();
  const { providers } = await client.goose.providersCatalogList_unstable(format ? { format } : {});
  return providers;
}

export async function acpGetProviderTemplate(providerId: string): Promise<ProviderTemplateDto> {
  const client = await getAcpClient();
  const { template } = await client.goose.providersCatalogTemplate_unstable({ providerId });
  return template;
}

export async function acpGetCustomProvider(
  providerId: string
): Promise<CustomProviderReadResponse_unstable> {
  const client = await getAcpClient();
  return client.goose.providersCustomRead_unstable({ providerId });
}

export async function acpCreateCustomProviderFromRequest(
  request: UpdateCustomProviderRequest
): Promise<{ provider_name: string }> {
  const client = await getAcpClient();
  const response = await client.goose.providersCustomCreate_unstable(
    updateRequestToCreate(request)
  );
  return { provider_name: response.providerId };
}

export async function acpDiscoverCustomProviderModels(
  request: UpdateCustomProviderRequest,
  providerId?: string
): Promise<string[]> {
  const client = await getAcpClient();
  const discoveryRequest: CustomProviderDiscoverModelsRequest_unstable = {
    engine: request.engine,
    apiUrl: request.api_url,
    requiresAuth: request.requires_auth,
    providerId: providerId || null,
    basePath: request.base_path || null,
    apiKey: request.api_key || null,
    headers: request.headers ?? {},
  };
  const response = await client.goose.providersCustomDiscoverModels_unstable(discoveryRequest);
  return response.models;
}

export async function acpUpdateCustomProviderFromRequest(
  providerId: string,
  request: UpdateCustomProviderRequest
): Promise<void> {
  const client = await getAcpClient();
  await client.goose.providersCustomUpdate_unstable({
    providerId,
    ...updateRequestToCreate(request),
  });
}

export async function acpDeleteCustomProvider(providerId: string): Promise<void> {
  const client = await getAcpClient();
  await client.goose.providersCustomDelete_unstable({ providerId });
}

export async function acpReadProviderConfig(providerId: string) {
  const client = await getAcpClient();
  const { fields } = await client.goose.providersConfigRead_unstable({ providerId });
  return fields;
}

export async function acpDeleteProviderConfig(providerId: string): Promise<void> {
  const client = await getAcpClient();
  await client.goose.providersConfigDelete_unstable({ providerId });
}

export async function acpSaveProviderConfig(
  providerId: string,
  fields: { key: string; value: string }[],
  clearFields: string[] = []
): Promise<void> {
  const client = await getAcpClient();
  await client.goose.providersConfigSave_unstable({ providerId, fields, clearFields });
}

export async function acpAuthenticateProvider(providerId: string): Promise<void> {
  const client = await getAcpClient();
  await client.goose.providersConfigAuthenticate_unstable({ providerId });
}

export async function acpListProviderSecrets(): Promise<ProviderSecretDto[]> {
  const client = await getAcpClient();
  const { secrets } = await client.goose.providersSecretsList_unstable({});
  return secrets;
}

export async function acpDeleteProviderSecret(id: string): Promise<void> {
  const client = await getAcpClient();
  await client.goose.providersSecretsDelete_unstable({ id });
}

export async function acpGetCanonicalModelInfo(
  provider: string,
  model: string
): Promise<CanonicalModelInfoDto | null> {
  const client = await getAcpClient();
  const { modelInfo } = await client.goose.providersCanonicalModelInfo_unstable({
    provider,
    model,
  });
  return modelInfo ?? null;
}

export async function acpReadDefaults(): Promise<{
  providerId: string | null;
  modelId: string | null;
}> {
  const client = await getAcpClient();
  const response = await client.goose.defaultsRead_unstable({});
  const providerId = response.providerId?.trim();
  const modelId = response.modelId?.trim();
  if (!providerId || !modelId) {
    return { providerId: null, modelId: null };
  }
  return {
    providerId,
    modelId,
  };
}

export async function acpSaveDefaults(providerId: string, modelId: string): Promise<void> {
  const trimmedProviderId = providerId.trim();
  const trimmedModelId = modelId.trim();
  if (!trimmedProviderId || !trimmedModelId) {
    throw new Error('Provider and model are required');
  }
  const client = await getAcpClient();
  await client.goose.defaultsSave_unstable({
    providerId: trimmedProviderId,
    modelId: trimmedModelId,
  });
}

export async function acpClearDefaults(): Promise<void> {
  const client = await getAcpClient();
  await client.goose.defaultsClear_unstable({});
}

export async function acpReadThinkingEffort(): Promise<ThinkingEffort | null> {
  const response = await readPreferences(['gooseThinkingEffort']);
  const value = response.values.find((v) => v.key === 'gooseThinkingEffort')?.value;
  if (value === 'none') return 'off';
  return value === 'off' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
    ? value
    : null;
}

export async function acpReadModelThinkingSettings(
  providerId: string,
  modelId: string
): Promise<ModelThinkingSettings> {
  return (await acpReadModelDisplaySettings(providerId, modelId)).thinking;
}

export type ModelDisplaySettings = {
  thinking: ModelThinkingSettings;
  contextWindow: number | null;
  contextSource: string | null;
};

export async function acpReadModelDisplaySettings(
  providerId: string,
  modelId: string
): Promise<ModelDisplaySettings> {
  // These two existing reads can straddle a metadata refresh. Retry a lost
  // reasoning profile once; never synthesize levels from the model's name.
  for (let attempt = 0; ; attempt += 1) {
    const info = await acpGetCanonicalModelInfo(providerId, modelId);
    const fields = await acpReadProviderConfig(providerId);
    const raw = fields.find((field) => field.key === `thinkingEffort:${modelId}`)?.value;
    if (typeof raw !== 'string') throw new Error('Model thinking settings are unavailable');
    const data = JSON.parse(raw) as { options?: unknown; value?: unknown; toggle?: unknown };
    const known = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    if (!Array.isArray(data.options) || !data.options.every((value) => known.includes(value)))
      throw new Error('Invalid model thinking options');
    const options = data.options.map((value) =>
      value === 'none' ? 'off' : value
    ) as ThinkingEffort[];
    const value = data.value === 'none' ? 'off' : data.value;
    if (value !== null && !options.includes(value as ThinkingEffort))
      throw new Error('Invalid model thinking selection');
    let contextWindow: number | null = null;
    let contextSource: string | null = null;
    try {
      const context = JSON.parse(
        fields.find((field) => field.key === `contextWindow:${modelId}`)?.value ?? 'null'
      );
      if (Number.isSafeInteger(context?.contextWindow) && context.contextWindow > 0) {
        contextWindow = context.contextWindow;
        contextSource = typeof context.contextSource === 'string' ? context.contextSource : null;
      }
    } catch {
      /* Optional display metadata does not invalidate a valid thinking configuration. */
    }
    if (attempt === 0 && info?.reasoning && !options.length) continue;
    return {
      thinking: { options, value: value as ThinkingEffort | null, toggle: data.toggle === true },
      contextWindow,
      contextSource,
    };
  }
}

export async function acpSaveThinkingEffort(
  effort: ThinkingEffort,
  providerId?: string,
  modelId?: string
): Promise<void> {
  const value = effort === 'off' ? 'none' : effort;
  if (providerId && modelId) {
    await acpSaveProviderConfig(providerId, [{ key: `thinkingEffort:${modelId}`, value }]);
    notifyThinkingEffort(providerId, modelId, readThinkingDraft(providerId, modelId) ?? effort);
    return;
  }
  await savePreferences([{ key: 'gooseThinkingEffort', value, isMutable: true }]);
}

// Composer changes are drafts. Persist through the existing settings owner only
// when a user submits a prompt, never while another turn is running.
const thinkingDrafts = new Map<string, ThinkingEffort>();
const thinkingDraftKey = (provider: string, model: string) => JSON.stringify([provider, model]);
function notifyThinkingEffort(provider: string, model: string, effort: ThinkingEffort) {
  window.dispatchEvent(new CustomEvent('codebuddy:thinking-effort-changed', { detail: { provider, model, effort } }));
}
export function readThinkingDraft(provider: string, model: string) {
  return thinkingDrafts.get(thinkingDraftKey(provider, model));
}
export function stageThinkingEffort(provider: string, model: string, effort: ThinkingEffort) {
  thinkingDrafts.set(thinkingDraftKey(provider, model), effort);
  notifyThinkingEffort(provider, model, effort);
}
export async function applyThinkingDraft(provider: string, model: string) {
  const key = thinkingDraftKey(provider, model);
  const effort = thinkingDrafts.get(key);
  if (effort === undefined) return;
  await acpSaveThinkingEffort(effort, provider, model);
  // A later edit made during the request belongs to the next prompt.
  if (thinkingDrafts.get(key) === effort) thinkingDrafts.delete(key);
}

export type AppliedSessionProviderModel = {
  providerId?: string;
  modelId?: string;
};

function extractAppliedSessionProviderModel(configOptions: unknown): AppliedSessionProviderModel {
  if (!Array.isArray(configOptions)) {
    return {};
  }

  const applied: AppliedSessionProviderModel = {};

  for (const option of configOptions) {
    if (!option || typeof option !== 'object') {
      continue;
    }

    const id = 'id' in option ? option.id : undefined;
    if (id !== 'provider' && id !== 'model') {
      continue;
    }

    const currentValue = selectCurrentValue(option);
    if (typeof currentValue !== 'string') {
      continue;
    }

    if (id === 'provider') {
      applied.providerId = currentValue;
    } else {
      applied.modelId = currentValue;
    }
  }

  return applied;
}

function selectCurrentValue(kind: unknown): unknown {
  if (!kind || typeof kind !== 'object') {
    return undefined;
  }

  if ('type' in kind && kind.type === 'select' && 'currentValue' in kind) {
    return kind.currentValue;
  }

  return undefined;
}

/**
 * Switch the provider (and model) for an active session via ACP config options.
 *
 * Provider and model are submitted as one server-side transaction so a failed
 * model selection cannot leave the session on a different provider.
 */
export async function acpSetSessionProviderModel(
  sessionId: string,
  providerId: string,
  modelId?: string | null,
  thinkingEffort?: ThinkingEffort | null
): Promise<AppliedSessionProviderModel> {
  const client = await getAcpClient();
  const response = await client.setSessionConfigOption({
    sessionId,
    configId: 'provider_model',
    value: JSON.stringify({
      providerId,
      modelId: modelId ?? null,
      thinkingEffort: thinkingEffort ?? null,
    }),
  });

  return extractAppliedSessionProviderModel(response.configOptions);
}
