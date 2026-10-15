import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAcpClient } from './acpConnection';
import {
  applyCodeProDefaultModelTransaction,
  readCodeProModelRouting,
  saveCodeProModelRouting,
} from './codeproModelRouting';

vi.mock('./acpConnection', () => ({
  getAcpClient: vi.fn(),
}));

const config = {
  version: 2 as const,
  advancedRoutingEnabled: true,
  routes: [
    { role: 'planner' as const, providerId: 'ollama_cloud', modelId: 'glm-5.3' },
    { role: 'coder' as const, providerId: 'ollama_cloud', modelId: 'glm-5.3' },
    { role: 'tester' as const, providerId: 'openai_codex_cli', modelId: 'gpt-5.2-codex' },
    {
      role: 'reviewer' as const,
      providerId: 'openai_codex_cli',
      modelId: 'gpt-5.1-codex-max',
    },
  ],
  visionRoute: {
    enabled: true,
    mode: 'auto' as const,
    providerId: 'custom_ollama',
    modelId: 'kimi-k3',
  },
  maxParallelCoders: 1,
};

describe('CodePro model routing ACP contract', () => {
  const extMethod = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAcpClient).mockResolvedValue({ extMethod } as never);
  });

  it('reads the canonical typed routing document', async () => {
    extMethod.mockResolvedValue({ config });

    await expect(readCodeProModelRouting()).resolves.toEqual(config);
    expect(extMethod).toHaveBeenCalledWith('_goose/unstable/codepro/model-routing/read', {});
  });

  it('saves through the validated model-routing endpoint', async () => {
    extMethod.mockResolvedValue(config);

    await saveCodeProModelRouting(config);
    expect(extMethod).toHaveBeenCalledWith('_goose/unstable/codepro/model-routing/save', {
      config,
    });
  });

  it('serializes ordinary switches and discards a stale transaction before it can commit', async () => {
    extMethod.mockResolvedValue({ config });
    let releaseFirst!: (value: boolean) => void;
    const firstApply = vi.fn(() => new Promise<boolean>((resolve) => (releaseFirst = resolve)));
    const secondApply = vi.fn().mockResolvedValue(true);

    const first = applyCodeProDefaultModelTransaction(firstApply);
    await vi.waitFor(() => expect(firstApply).toHaveBeenCalledTimes(1));
    const second = applyCodeProDefaultModelTransaction(secondApply);
    releaseFirst(true);

    await expect(first).resolves.toMatchObject({ status: 'superseded' });
    await expect(second).resolves.toMatchObject({ status: 'applied' });
    expect(secondApply).toHaveBeenCalledTimes(1);
    expect(extMethod).toHaveBeenLastCalledWith('_goose/unstable/codepro/model-routing/save', {
      config: {
        ...config,
        advancedRoutingEnabled: false,
      },
    });
  });

  it.each([true, false])(
    'keeps an unchanged disabled route out of a model switch (applied=%s)',
    async (applied) => {
      const disabled = {
        ...config,
        advancedRoutingEnabled: false,
        visionRoute: {
          enabled: true,
          mode: 'auto' as const,
          providerId: 'custom_codebuddy_lan',
          modelId: 'qwen3.8-flash-next',
        },
      };
      extMethod.mockImplementation(async (method: string) => {
        if (method.endsWith('/read')) return { config: disabled };
        throw Object.assign(new Error('Invalid params'), {
          code: -32602,
          data: { code: 'custom_provider_model_unavailable' },
        });
      });
      const apply = vi.fn().mockResolvedValue(applied);

      await expect(applyCodeProDefaultModelTransaction(apply)).resolves.toMatchObject({
        status: applied ? 'applied' : 'failed',
      });
      expect(apply).toHaveBeenCalledTimes(1);
      expect(extMethod.mock.calls.map(([method]) => method)).toEqual([
        '_goose/unstable/codepro/model-routing/read',
      ]);
      expect(disabled.visionRoute.modelId).toBe('qwen3.8-flash-next');
      expect(disabled.routes).toEqual(config.routes);
    }
  );

  it('switches the default without creating an absent advanced routing document', async () => {
    extMethod.mockResolvedValue({ config: null });
    const apply = vi.fn().mockResolvedValue(true);
    await expect(applyCodeProDefaultModelTransaction(apply)).resolves.toMatchObject({
      status: 'applied',
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(extMethod).toHaveBeenCalledTimes(1);
  });

  it('restores advanced routing when the model/default mutation fails', async () => {
    extMethod.mockImplementation(async (method: string) =>
      method.endsWith('/read') ? { config } : config
    );

    await expect(applyCodeProDefaultModelTransaction(async () => false)).resolves.toMatchObject({
      status: 'failed',
    });
    expect(extMethod).toHaveBeenLastCalledWith('_goose/unstable/codepro/model-routing/save', {
      config,
    });
  });

  it.each([true, false])(
    'leaves inactive routing untouched when switching models (applied=%s)',
    async (applied) => {
      const inactive = { ...config, advancedRoutingEnabled: false };
      extMethod.mockImplementation(async (method: string) => {
        if (method.endsWith('/read')) return { config: inactive };
        throw new Error('The saved auxiliary model is no longer available');
      });
      const apply = vi.fn().mockResolvedValue(applied);

      await expect(applyCodeProDefaultModelTransaction(apply)).resolves.toMatchObject({
        status: applied ? 'applied' : 'failed',
      });
      expect(apply).toHaveBeenCalledTimes(1);
      expect(extMethod).toHaveBeenCalledTimes(1);
      expect(extMethod).toHaveBeenCalledWith('_goose/unstable/codepro/model-routing/read', {});
    }
  );
});
