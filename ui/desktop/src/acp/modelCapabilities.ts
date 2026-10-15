import { getAcpClient } from './acpConnection';

const READ_METHOD = '_goose/unstable/model-capabilities/read';
const SAVE_METHOD = '_goose/unstable/model-capabilities/save';
const RESOLVE_METHOD = '_goose/unstable/model-capabilities/resolve';

export type ImageInputOverride = 'auto' | 'force_supported' | 'force_unsupported';
export type ModelCapabilityState = 'supported' | 'unsupported' | 'unknown';
export type ModelCapabilitySource =
  | 'user_override'
  | 'provider_metadata'
  | 'probe'
  | 'catalog'
  | 'heuristic'
  | 'unknown';

export interface ModelCapabilityOverride {
  providerId: string;
  modelId: string;
  imageInput: ImageInputOverride;
}

export interface ModelCapabilityOverridesConfig {
  version: 1;
  overrides: ModelCapabilityOverride[];
}

export interface ResolvedModelCapability {
  providerId: string;
  modelId: string;
  imageInput: ModelCapabilityState;
  source: ModelCapabilitySource;
}

export const EMPTY_MODEL_CAPABILITY_OVERRIDES: ModelCapabilityOverridesConfig = {
  version: 1,
  overrides: [],
};

export const modelCapabilityKey = (providerId: string, modelId: string) =>
  `${providerId.trim().toLocaleLowerCase()}\0${modelId.trim().toLocaleLowerCase()}`;

export async function readModelCapabilityOverrides(): Promise<ModelCapabilityOverridesConfig> {
  const client = await getAcpClient();
  const response = (await client.extMethod(READ_METHOD, {})) as {
    config?: ModelCapabilityOverridesConfig;
  };
  return response.config ?? EMPTY_MODEL_CAPABILITY_OVERRIDES;
}

export async function saveModelCapabilityOverrides(
  config: ModelCapabilityOverridesConfig
): Promise<void> {
  const client = await getAcpClient();
  await client.extMethod(SAVE_METHOD, { config });
}

export async function resolveModelCapability(
  providerId: string,
  modelId: string
): Promise<ResolvedModelCapability> {
  const client = await getAcpClient();
  return (await client.extMethod(RESOLVE_METHOD, {
    providerId,
    modelId,
  })) as unknown as ResolvedModelCapability;
}
