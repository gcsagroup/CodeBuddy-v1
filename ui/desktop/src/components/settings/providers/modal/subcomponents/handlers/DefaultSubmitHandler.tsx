import { acpSaveProviderConfig } from '../../../../../../acp/providers';

/**
 * Submit provider configuration through ACP.
 *
 * The ACP server validates the supplied fields, persists config/secret values,
 * and triggers an inventory refresh in a single call, so no client-side
 * rollback is required.
 */
export const providerConfigSubmitHandler = async (
  provider: {
    name: string;
    metadata: {
      config_keys?: Array<{ name: string; default?: unknown }>;
    };
  },
  configValues: Record<string, string>
) => {
  const endpointKeys = ['OPENAI_HOST', 'OPENAI_BASE_URL'] as const;
  const selectedEndpointKeys =
    provider.name === 'openai'
      ? endpointKeys.filter((key) => (configValues[key] ?? '').trim() !== '')
      : [];
  if (selectedEndpointKeys.length > 1) {
    throw new Error('OPENAI_HOST and OPENAI_BASE_URL are mutually exclusive');
  }
  const selectedEndpoint = selectedEndpointKeys[0];
  const fields: { key: string; value: string }[] = [];
  for (const { name, default: defaultValue } of provider.metadata.config_keys ?? []) {
    if (
      provider.name === 'openai' &&
      endpointKeys.includes(name as (typeof endpointKeys)[number]) &&
      selectedEndpoint &&
      name !== selectedEndpoint
    ) {
      continue;
    }
    const value = configValues[name] ?? defaultValue;
    if (value === undefined || value === null || value === '') {
      continue;
    }
    fields.push({ key: name, value: String(value) });
  }

  const clearFields = selectedEndpoint
    ? endpointKeys.filter((key) => key !== selectedEndpoint)
    : [];
  await acpSaveProviderConfig(provider.name, fields, clearFields);
};
