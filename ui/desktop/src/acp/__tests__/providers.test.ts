import { beforeEach, describe, expect, it, vi } from 'vitest';
import { zListProvidersResponse_unstable } from '@aaif/goose-sdk';
import { getAcpClient } from '../acpConnection';
import { acpListProviderDetails, acpSetSessionProviderModel } from '../providers';

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
