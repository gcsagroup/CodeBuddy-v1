import { beforeEach, describe, expect, it, vi } from 'vitest';
import { zListProvidersResponse_unstable } from '@aaif/goose-sdk';
import { getAcpClient } from '../acpConnection';
import {
  acpListProviderDetails,
  acpReadModelDisplaySettings,
  acpSetSessionProviderModel,
} from '../providers';

vi.mock('../acpConnection', () => ({
  getAcpClient: vi.fn(),
}));

function selectConfigOption(id: string, currentValue: string) {
  return {
    id,
    name: id,
    type: 'select',
    currentValue,
    options: [],
  };
}

describe('ACP providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const recover of [true, false])
    it(`bounds retries when a metadata refresh removes thinking details (recovery ${recover})`, async () => {
      const model = 'reasoning-model';
      const fields = (ready: boolean) => ({
        fields: [
          {
            key: `thinkingEffort:${model}`,
            value: JSON.stringify(
              ready
                ? { options: ['none', 'low', 'high'], value: 'high', toggle: false }
                : { options: [], value: null, toggle: false }
            ),
          },
          {
            key: `contextWindow:${model}`,
            value: JSON.stringify({
              contextWindow: ready ? 1048576 : 262144,
              contextSource: ready ? 'service' : 'fallback',
            }),
          },
        ],
      });
      const canonical = vi.fn().mockResolvedValue({
        modelInfo: {
          provider: 'p',
          model,
          contextLimit: 1048576,
          reasoning: true,
          currency: 'USD',
        },
      });
      const config = vi
        .fn()
        .mockResolvedValueOnce(fields(false))
        .mockResolvedValue(fields(recover));
      vi.mocked(getAcpClient).mockResolvedValue({
        goose: {
          providersCanonicalModelInfo_unstable: canonical,
          providersConfigRead_unstable: config,
        },
      } as unknown as Awaited<ReturnType<typeof getAcpClient>>);
      const result = await acpReadModelDisplaySettings('p', model);
      expect(canonical).toHaveBeenCalledTimes(2);
      expect(config).toHaveBeenCalledTimes(2);
      expect(result.thinking.options).toEqual(recover ? ['off', 'low', 'high'] : []);
      expect(result.contextWindow).toBe(recover ? 1048576 : 262144);
    });

  it('keeps an explicitly non-reasoning model unchanged without extra reads', async () => {
    const canonical = vi.fn().mockResolvedValue({
      modelInfo: {
        provider: 'p',
        model: 'plain',
        contextLimit: 32768,
        reasoning: false,
        currency: 'USD',
      },
    });
    const config = vi.fn().mockResolvedValue({
      fields: [
        {
          key: 'thinkingEffort:plain',
          value: JSON.stringify({ options: [], value: null, toggle: false }),
        },
        {
          key: 'contextWindow:plain',
          value: JSON.stringify({ contextWindow: 32768, contextSource: 'service' }),
        },
      ],
    });
    vi.mocked(getAcpClient).mockResolvedValue({
      goose: {
        providersCanonicalModelInfo_unstable: canonical,
        providersConfigRead_unstable: config,
      },
    } as unknown as Awaited<ReturnType<typeof getAcpClient>>);
    expect((await acpReadModelDisplaySettings('p', 'plain')).thinking.options).toEqual([]);
    expect(canonical).toHaveBeenCalledTimes(1);
    expect(config).toHaveBeenCalledTimes(1);
  });

  it('sets provider, model, and thinking effort in one server transaction', async () => {
    const client = {
      setSessionConfigOption: vi.fn().mockResolvedValueOnce({
        configOptions: [
          selectConfigOption('provider', 'anthropic'),
          selectConfigOption('model', 'claude-sonnet-4-5'),
          selectConfigOption('thinking_effort', 'high'),
        ],
      }),
    };
    vi.mocked(getAcpClient).mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getAcpClient>>
    );

    const applied = await acpSetSessionProviderModel(
      'session-1',
      'anthropic',
      'claude-sonnet-4-5',
      'high'
    );

    expect(client.setSessionConfigOption).toHaveBeenCalledTimes(1);
    expect(client.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'session-1',
      configId: 'provider_model',
      value: JSON.stringify({
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-5',
        thinkingEffort: 'high',
      }),
    });
    expect(applied).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
    });
  });

  it('keeps unsupported credential validation disabled through generated parsing', async () => {
    const parsed = zListProvidersResponse_unstable.parse({
      entries: [
        {
          providerId: 'zai',
          providerName: 'Z.AI',
          description: 'Z.AI models',
          defaultModel: 'glm-4.5',
          configured: false,
          providerType: 'Builtin',
          category: 'model',
          configKeys: [
            {
              name: 'ZHIPU_API_KEY',
              required: true,
              secret: true,
              primary: true,
              credentialValidationSupported: false,
              credentialValidationUnavailableReason: 'Credential validation is unavailable.',
            },
          ],
          setupSteps: [],
          supportsRefresh: false,
          refreshing: false,
          models: [],
          stale: false,
        },
      ],
    });
    const client = {
      goose: {
        providersList_unstable: vi.fn().mockResolvedValue(parsed),
      },
    };
    vi.mocked(getAcpClient).mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getAcpClient>>
    );

    const [provider] = await acpListProviderDetails();

    expect(provider.category).toBe('model');
    expect(provider.metadata.config_keys[0]).toMatchObject({
      credential_validation_supported: false,
      credential_validation_unavailable_reason: 'Credential validation is unavailable.',
    });

    const missingValidationCapability = JSON.parse(JSON.stringify(parsed));
    delete missingValidationCapability.entries[0].configKeys[0].credentialValidationSupported;
    expect(() => zListProvidersResponse_unstable.parse(missingValidationCapability)).toThrow();

    const missingValidationReason = JSON.parse(JSON.stringify(parsed));
    delete missingValidationReason.entries[0].configKeys[0].credentialValidationUnavailableReason;
    expect(() => zListProvidersResponse_unstable.parse(missingValidationReason)).toThrow();
  });
});
