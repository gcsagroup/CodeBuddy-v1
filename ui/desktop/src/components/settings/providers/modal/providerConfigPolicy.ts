export const OPENAI_ENDPOINT_KEYS = ['OPENAI_HOST', 'OPENAI_BASE_URL'] as const;

type ConfigInputLike = {
  serverValue?: unknown;
  value?: string;
};

function hasConfiguredValue(entry: ConfigInputLike | undefined): boolean {
  if (entry?.value !== undefined) {
    return entry.value.trim() !== '';
  }
  if (typeof entry?.serverValue === 'string') {
    return entry.serverValue.trim() !== '';
  }
  return entry?.serverValue != null;
}

export function isRequiredProviderFieldSatisfied(
  providerName: string,
  fieldName: string,
  configValues: Record<string, ConfigInputLike>
): boolean {
  if (providerName === 'openai' && fieldName === 'OPENAI_HOST') {
    return OPENAI_ENDPOINT_KEYS.some((key) => hasConfiguredValue(configValues[key]));
  }
  return hasConfiguredValue(configValues[fieldName]);
}

export function resolvedNonSecretConfigValues(
  configValues: Record<string, ConfigInputLike>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(configValues)
      .map(([key, entry]) => [
        key,
        entry.value ?? (typeof entry.serverValue === 'string' ? entry.serverValue : ''),
      ])
      .filter(([, value]) => value.trim() !== '')
  );
}
