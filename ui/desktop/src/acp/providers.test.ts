import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAcpClient } from './acpConnection';
import { readPreferences, savePreferences } from './preferences';
import {
  acpDiscoverCustomProviderModels,
  acpListProviderModels,
  acpReadDefaults,
  acpReadThinkingEffort,
  acpSaveDefaults,
  acpSaveThinkingEffort,
} from './providers';

vi.mock('./acpConnection', () => ({
  getAcpClient: vi.fn(),
}));

vi.mock('./preferences', () => ({
  readPreferences: vi.fn(),
  savePreferences: vi.fn(),
}));

describe('acpListProviderModels', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns the complete stable unique live model list instead of the static inventory fallback', async () => {
    const client = {
      goose: {
        providersList_unstable: vi.fn().mockResolvedValue({
          entries: [
            {
              providerId: 'ollama_cloud',
              models: [{ id: 'glm-5.2', name: 'glm-5.2' }],
            },
          ],
        }),
        providersSupportedModelsList_unstable: vi.fn().mockResolvedValue({
          providerId: 'ollama_cloud',
          models: ['qwen3-coder', 'glm-5.2', 'qwen3-coder', '  ', 'kimi-k2.7-code'],
        }),
      },
    };
    vi.mocked(getAcpClient).mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getAcpClient>>
    );

    const models = await acpListProviderModels('ollama_cloud');

    expect(models.map((model) => model.id)).toEqual(['qwen3-coder', 'glm-5.2', 'kimi-k2.7-code']);
  });

  it('propagates live discovery failures instead of silently returning static inventory models', async () => {
    const discoveryError = new Error('model discovery unavailable');
    const client = {
      goose: {
        providersList_unstable: vi.fn().mockResolvedValue({
          entries: [
            {
              providerId: 'ollama_cloud',
              models: [{ id: 'glm-5.2', name: 'glm-5.2' }],
            },
          ],
        }),
        providersSupportedModelsList_unstable: vi.fn().mockRejectedValue(discoveryError),
      },
    };
    vi.mocked(getAcpClient).mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getAcpClient>>
    );

    await expect(acpListProviderModels('ollama_cloud')).rejects.toBe(discoveryError);
  });
});

describe('custom provider discovery', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('passes the existing provider id so an unchanged saved key can be reused safely', async () => {
    const providersCustomDiscoverModels_unstable = vi.fn().mockResolvedValue({
      models: ['verified-model'],
    });
    vi.mocked(getAcpClient).mockResolvedValue({
      goose: { providersCustomDiscoverModels_unstable },
    } as never);

    await expect(
      acpDiscoverCustomProviderModels(
        {
          engine: 'openai_compatible',
          display_name: 'Office API',
          api_url: 'https://models.example.test',
          api_key: '',
          models: [],
          supports_streaming: true,
          requires_auth: true,
          headers: {},
          base_path: '/v1',
        },
        'custom_office_api'
      )
    ).resolves.toEqual(['verified-model']);

    expect(providersCustomDiscoverModels_unstable).toHaveBeenCalledWith({
      engine: 'openai_compatible',
      apiUrl: 'https://models.example.test',
      requiresAuth: true,
      providerId: 'custom_office_api',
      basePath: '/v1',
      apiKey: null,
      headers: {},
    });
  });
});

describe('provider defaults', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('trims and saves one complete provider-model pair exactly once', async () => {
    const defaultsSave_unstable = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getAcpClient).mockResolvedValue({
      goose: { defaultsSave_unstable },
    } as never);

    await acpSaveDefaults('  openai  ', '  gpt-4.1  ');

    expect(defaultsSave_unstable).toHaveBeenCalledTimes(1);
    expect(defaultsSave_unstable).toHaveBeenCalledWith({
      providerId: 'openai',
      modelId: 'gpt-4.1',
    });
  });

  it.each([
    ['blank provider', '   ', 'gpt-4.1'],
    ['blank model', 'openai', '   '],
  ])('rejects %s before acquiring an ACP client', async (_label, providerId, modelId) => {
    await expect(acpSaveDefaults(providerId, modelId)).rejects.toThrow(
      'Provider and model are required'
    );

    expect(getAcpClient).not.toHaveBeenCalled();
  });

  it('trims a complete provider-model pair when reading defaults', async () => {
    const defaultsRead_unstable = vi.fn().mockResolvedValue({
      providerId: '  openai  ',
      modelId: '  gpt-4.1  ',
    });
    vi.mocked(getAcpClient).mockResolvedValue({
      goose: { defaultsRead_unstable },
    } as never);

    await expect(acpReadDefaults()).resolves.toEqual({
      providerId: 'openai',
      modelId: 'gpt-4.1',
    });
    expect(defaultsRead_unstable).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing provider', null, 'gpt-4.1'],
    ['missing model', 'openai', null],
    ['blank provider', '   ', 'gpt-4.1'],
    ['blank model', 'openai', '   '],
  ])('fails closed to an empty pair when defaults are %s', async (_label, providerId, modelId) => {
    const defaultsRead_unstable = vi.fn().mockResolvedValue({ providerId, modelId });
    vi.mocked(getAcpClient).mockResolvedValue({
      goose: { defaultsRead_unstable },
    } as never);

    await expect(acpReadDefaults()).resolves.toEqual({ providerId: null, modelId: null });
  });

  it('propagates a defaults read failure unchanged without a fallback call', async () => {
    const failure = { code: 'defaults_read_unavailable' };
    const defaultsRead_unstable = vi.fn().mockRejectedValue(failure);
    const defaultsSave_unstable = vi.fn();
    vi.mocked(getAcpClient).mockResolvedValue({
      goose: { defaultsRead_unstable, defaultsSave_unstable },
    } as never);

    await expect(acpReadDefaults()).rejects.toBe(failure);
    expect(getAcpClient).toHaveBeenCalledTimes(1);
    expect(defaultsRead_unstable).toHaveBeenCalledTimes(1);
    expect(defaultsSave_unstable).not.toHaveBeenCalled();
  });

  it('propagates a defaults save failure unchanged without retry or fallback', async () => {
    const failure = { code: 'defaults_save_unavailable' };
    const defaultsRead_unstable = vi.fn();
    const defaultsSave_unstable = vi.fn().mockRejectedValue(failure);
    vi.mocked(getAcpClient).mockResolvedValue({
      goose: { defaultsRead_unstable, defaultsSave_unstable },
    } as never);

    await expect(acpSaveDefaults('openai', 'gpt-4.1')).rejects.toBe(failure);
    expect(getAcpClient).toHaveBeenCalledTimes(1);
    expect(defaultsSave_unstable).toHaveBeenCalledTimes(1);
    expect(defaultsRead_unstable).not.toHaveBeenCalled();
  });
});

describe('thinking effort preferences', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each(['off', 'low', 'medium', 'high', 'max'] as const)(
    'reads the valid %s effort through the typed preferences adapter',
    async (effort) => {
      vi.mocked(readPreferences).mockResolvedValue({
        revision: 8,
        values: [{ key: 'gooseThinkingEffort', value: effort, isMutable: true }],
      });

      await expect(acpReadThinkingEffort()).resolves.toBe(effort);
      expect(readPreferences).toHaveBeenCalledWith(['gooseThinkingEffort']);
      expect(getAcpClient).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, null, '', 'ultra', 7])(
    'returns null for an invalid authoritative effort: %j',
    async (effort) => {
      vi.mocked(readPreferences).mockResolvedValue({
        revision: 9,
        values:
          effort === undefined
            ? []
            : [{ key: 'gooseThinkingEffort', value: effort as never, isMutable: true }],
      });

      await expect(acpReadThinkingEffort()).resolves.toBeNull();
      expect(getAcpClient).not.toHaveBeenCalled();
    }
  );

  it.each(['off', 'low', 'medium', 'high', 'max'] as const)(
    'passes the valid %s effort exactly to the typed preferences adapter',
    async (effort) => {
      vi.mocked(savePreferences).mockResolvedValue({ revision: 10, values: [] });

      await acpSaveThinkingEffort(effort);

      expect(savePreferences).toHaveBeenCalledTimes(1);
      expect(savePreferences).toHaveBeenCalledWith([
        { key: 'gooseThinkingEffort', value: effort === 'off' ? 'none' : effort, isMutable: true },
      ]);
      expect(getAcpClient).not.toHaveBeenCalled();
    }
  );
});
