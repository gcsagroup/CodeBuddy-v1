export type ProviderType = 'Preferred' | 'Builtin' | 'Declarative' | 'Custom';

export type ThinkingEffort = 'default' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ModelThinkingSettings = {
  options: ThinkingEffort[];
  value: ThinkingEffort | null;
  toggle: boolean;
  source?: 'models' | 'openapi' | 'tokenize';
  state?: 'supported' | 'unsupported' | 'unknown';
  stalePreference?: boolean;
};

export type ConfigKey = {
  default?: string | null;
  device_code_flow?: boolean;
  name: string;
  oauth_flow: boolean;
  primary?: boolean;
  required: boolean;
  secret: boolean;
  credential_validation_supported: boolean;
  credential_validation_unavailable_reason: string | null;
};

export type ModelInfo = {
  context_limit: number;
  currency?: string | null;
  input_token_cost?: number | null;
  name: string;
  output_token_cost?: number | null;
  reasoning?: boolean;
  resolved_model?: string | null;
  supports_cache_control?: boolean | null;
};

export type ProviderMetadata = {
  config_keys: ConfigKey[];
  default_model: string;
  description: string;
  display_name: string;
  fast_model?: string | null;
  known_models: ModelInfo[];
  model_doc_link: string;
  model_selection_hint?: string | null;
  name: string;
  setup_steps?: string[];
};

export type ProviderDetails = {
  category?: 'agent' | 'model';
  is_configured: boolean;
  metadata: ProviderMetadata;
  name: string;
  provider_type: ProviderType;
  saved_model?: string | null;
};

export function providerActivationDisabledReason(provider: ProviderDetails): string | null {
  return (
    (provider.metadata.config_keys ?? []).find(
      (key) =>
        key.primary &&
        key.secret &&
        !key.oauth_flow &&
        key.credential_validation_supported === false
    )?.credential_validation_unavailable_reason ?? null
  );
}

export type UpdateCustomProviderRequest = {
  api_key: string;
  api_url: string;
  base_path?: string | null;
  auto_append_api_version?: boolean;
  catalog_provider_id?: string | null;
  display_name: string;
  engine: string;
  headers?: Record<string, string> | null;
  models: string[];
  preserves_thinking?: boolean | null;
  requires_auth?: boolean;
  supports_streaming?: boolean | null;
};
