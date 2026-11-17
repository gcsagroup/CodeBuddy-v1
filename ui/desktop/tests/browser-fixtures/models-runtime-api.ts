import { useState } from 'react';
import { getAcpClient as getFixtureClient } from './compaction-settings-api';

const visionModel = 'CUA-S1-Qwen3.5-4B';

export async function getAcpClient() {
  const { goose } = await getFixtureClient();
  return {
    goose: {
      ...goose,
      configExtensionsList_unstable: async () => ({ extensions: [], warnings: [] }),
      providersSecretsList_unstable: async () => ({
        secrets: new URLSearchParams(location.search).has('credentialFixture')
          ? [{
              id: 'fixture-secret', provider: 'fixture',
              providerDisplayName: 'Fixture Provider', name: 'FIXTURE_PROVIDER_API_KEY',
              storage: 'secret_store', status: 'valid', expiresAt: '2030-01-01T00:00:00Z',
              configured: true, hasSecret: true, canDelete: true, canConfigure: true,
              configureProvider: 'fixture',
            }]
          : [],
      }),
      preferencesRead_unstable: async () => ({
        revision: 1,
        values: [{ key: 'personalizedMemoryEnabled', value: false, isMutable: true }],
      }),
      async configRead_unstable({ key }: { key: string }) {
        const result = await goose.configRead_unstable({ key });
        return key === 'subagentLimits' && result.value === null
          ? { value: { maxDepth: 1, maxActiveSubagents: 3 } }
          : result;
      },
      providersSupportedModelsList_unstable: async () => ({ models: [visionModel] }),
      async providersConfigRead_unstable() {
        const { entries } = await goose.providersList_unstable();
        return {
          fields: entries.flatMap(({ models }) =>
            models.flatMap(({ id, contextLimit }) => [
              {
                key: 'contextWindow:' + id,
                value: JSON.stringify({
                  configured: null,
                  contextWindow: contextLimit,
                  contextSource: 'catalog',
                }),
              },
              {
                key: 'maxTokens:' + id,
                value: JSON.stringify({
                  configured: null,
                  capacityTokens: contextLimit,
                  capacitySource: 'catalog',
                  defaultTokens: 4096,
                }),
              },
            ])
          ),
        };
      },
    },
    async extMethod(method: string) {
      if (method.endsWith('/model-routing/read')) {
        return {
          config: {
            visionRoute: {
              enabled: true,
              mode: 'always',
              providerId: 'fixture',
              modelId: visionModel,
            },
          },
        };
      }
      throw new Error('Unexpected settings request: ' + method);
    },
  };
}

export async function getAcpControlClient() {
  return {
    async extMethod(method: string) {
      if (method === '_codebuddy/media/settings/read') {
        return { revision: 1, services: [], defaults: { image: null, video: null }, catalog: {} };
      }
      throw new Error('Unexpected control request: ' + method);
    },
  };
}

export function useSecurityFixtureConfig() {
  const [config, setConfig] = useState<Record<string, unknown>>({
    SECURITY_PROMPT_ENABLED: true,
    SECURITY_PROMPT_CLASSIFIER_ENABLED: true,
  });
  return {
    config,
    upsert: async (key: string, value: unknown) => setConfig(current => ({ ...current, [key]: value })),
  };
}
