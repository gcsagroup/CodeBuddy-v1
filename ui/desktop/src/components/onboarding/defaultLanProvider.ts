import { getAcpClient } from '../../acp/acpConnection';
import {
  acpCreateCustomProviderFromRequest,
  acpDiscoverCustomProviderModels,
  acpSaveDefaults,
} from '../../acp/providers';
import type { UpdateCustomProviderRequest } from '../../types/providers';

export const DEFAULT_LAN_PROVIDER: UpdateCustomProviderRequest = {
  engine: 'openai_compatible',
  display_name: 'CodeBuddy LAN',
  api_url: 'http://192.168.9.120:8001',
  api_key: '',
  models: [],
  supports_streaming: true,
  requires_auth: false,
  headers: {},
};

export class DefaultLanSetupError extends Error {
  constructor(public readonly reason: 'empty' | 'multiple' | 'timeout') {
    super(reason);
  }
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DefaultLanSetupError('timeout')), 60_000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

async function readDefaults() {
  const client = await bounded(getAcpClient());
  return bounded(client.goose.defaultsRead_unstable({}));
}

export async function ensureDefaultLanProvider(): Promise<void> {
  const defaults = await readDefaults();
  // A partial existing configuration also belongs to the user.
  if (defaults.providerId?.trim() || defaults.modelId?.trim()) return;

  const models = [
    ...new Set(
      (await bounded(acpDiscoverCustomProviderModels(DEFAULT_LAN_PROVIDER)))
        .map((model) => model.trim())
        .filter(Boolean)
    ),
  ];
  if (models.length !== 1) {
    throw new DefaultLanSetupError(models.length === 0 ? 'empty' : 'multiple');
  }
  const current = await readDefaults();
  if (current.providerId?.trim() || current.modelId?.trim()) return;
  const { provider_name } = await bounded(
    acpCreateCustomProviderFromRequest({
      ...DEFAULT_LAN_PROVIDER,
      models,
    })
  );
  const latest = await readDefaults();
  if (latest.providerId?.trim() || latest.modelId?.trim()) return;
  await bounded(acpSaveDefaults(provider_name, models[0]));
}
