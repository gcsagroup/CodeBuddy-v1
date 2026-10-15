import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readCodeProModelRouting,
  saveCodeProModelRouting,
  type CodeProModelRoutingConfig,
} from '../../acp/codeproModelRouting';
import {
  acpListProviderDetails,
  acpListProviderModels,
  acpReadDefaults,
} from '../../acp/providers';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { CodeProModelModal } from './CodeProModelModal';

vi.mock('../../acp/codeproModelRouting', () => ({
  DISABLED_CODEPRO_MODEL_ROUTING: {
    version: 2,
    visionRoute: { enabled: false, mode: 'disabled' },
    advancedRoutingEnabled: false,
    routes: [],
    maxParallelCoders: 1,
  },
  readCodeProModelRouting: vi.fn(),
  saveCodeProModelRouting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../acp/providers', () => ({
  acpListProviderDetails: vi.fn().mockResolvedValue([
    {
      name: 'ollama_cloud',
      is_configured: true,
      provider_type: 'Custom',
      metadata: { display_name: 'Ollama Cloud' },
    },
  ]),
  acpListProviderModels: vi.fn(),
  acpReadDefaults: vi.fn().mockResolvedValue({
    providerId: 'ollama_cloud',
    modelId: 'glm-5.2',
  }),
}));

const liveModels = [
  { id: 'qwen3-coder', name: 'qwen3-coder', contextLimit: 64_000, reasoning: false },
  { id: 'glm-5.2', name: 'glm-5.2', contextLimit: 256_000, reasoning: true },
  { id: 'kimi-k2.7-code', name: 'kimi-k2.7-code', contextLimit: 128_000, reasoning: true },
];

const routingFor = (providerId: string, modelId: string): CodeProModelRoutingConfig => ({
  version: 2,
  visionRoute: { enabled: false, mode: 'disabled' },
  advancedRoutingEnabled: true,
  routes: (['planner', 'coder', 'tester', 'reviewer'] as const).map((role) => ({
    role,
    providerId,
    modelId,
  })),
  maxParallelCoders: 1,
});

describe('CodeProModelModal model discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(acpReadDefaults).mockResolvedValue({
      providerId: 'ollama_cloud',
      modelId: 'glm-5.2',
    });
    vi.mocked(acpListProviderDetails).mockResolvedValue([
      {
        name: 'ollama_cloud',
        is_configured: true,
        provider_type: 'Custom',
        metadata: { display_name: 'Ollama Cloud', config_keys: [] },
      },
    ] as never);
    vi.mocked(readCodeProModelRouting).mockResolvedValue(routingFor('ollama_cloud', 'glm-5.2'));
    vi.mocked(saveCodeProModelRouting).mockResolvedValue(undefined);
    vi.mocked(acpListProviderModels).mockResolvedValue(liveModels);
  });

  it('excludes activation-disabled providers and makes zero model discovery requests for them', async () => {
    vi.mocked(acpListProviderDetails).mockResolvedValue([
      {
        name: 'ollama_cloud',
        is_configured: true,
        provider_type: 'Custom',
        metadata: { display_name: 'Ollama Cloud', config_keys: [] },
      },
      {
        name: 'zai',
        is_configured: true,
        provider_type: 'Custom',
        metadata: {
          display_name: 'Z.AI',
          config_keys: [
            {
              primary: true,
              secret: true,
              oauth_flow: false,
              credential_validation_supported: false,
              credential_validation_unavailable_reason: 'Credential validation unavailable',
            },
          ],
        },
      },
    ] as never);

    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });

    const providerSelect = await screen.findByLabelText('Coding agent provider');
    await waitFor(() =>
      expect(within(providerSelect).getAllByRole('option', { name: 'Ollama Cloud' })).toHaveLength(
        1
      )
    );
    expect(within(providerSelect).getByRole('option', { name: 'System default' })).toBeVisible();
    expect(within(providerSelect).queryByRole('option', { name: 'Z.AI' })).toBeNull();
    expect(acpListProviderModels).not.toHaveBeenCalledWith('zai');
  });

  it('excludes external agent providers from model discovery and model selectors', async () => {
    vi.mocked(acpListProviderDetails).mockResolvedValue([
      {
        name: 'ollama_cloud',
        category: 'model',
        is_configured: true,
        provider_type: 'Custom',
        metadata: { display_name: 'Ollama Cloud', config_keys: [] },
      },
      {
        name: 'external_cli',
        category: 'agent',
        is_configured: true,
        provider_type: 'Builtin',
        metadata: { display_name: 'External CLI', config_keys: [] },
      },
    ] as never);

    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });

    const providerSelect = await screen.findByLabelText('Coding agent provider');
    await waitFor(() => expect(acpListProviderModels).toHaveBeenCalledWith('ollama_cloud'));
    expect(acpListProviderModels).not.toHaveBeenCalledWith('external_cli');
    expect(within(providerSelect).queryByRole('option', { name: 'External CLI' })).toBeNull();
  });

  it('shows only configured custom connections without mixing in the built-in provider catalog', async () => {
    vi.mocked(acpListProviderDetails).mockResolvedValue([
      {
        name: 'custom_openai',
        category: 'model',
        is_configured: true,
        provider_type: 'Custom',
        metadata: { display_name: 'Custom OpenAI endpoint', config_keys: [] },
      },
      {
        name: 'amazon_bedrock',
        category: 'model',
        is_configured: true,
        provider_type: 'Builtin',
        metadata: { display_name: 'Amazon Bedrock', config_keys: [] },
      },
    ] as never);
    vi.mocked(acpReadDefaults).mockResolvedValue({
      providerId: 'custom_openai',
      modelId: 'qwen3-coder',
    });
    vi.mocked(readCodeProModelRouting).mockResolvedValue(
      routingFor('custom_openai', 'qwen3-coder')
    );

    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });

    const providerSelect = await screen.findByLabelText('Coding agent provider');
    await waitFor(() => expect(acpListProviderModels).toHaveBeenCalledWith('custom_openai'));
    expect(acpListProviderModels).not.toHaveBeenCalledWith('amazon_bedrock');
    expect(
      within(providerSelect)
        .getAllByRole('option', { name: 'Custom OpenAI endpoint' })
        .some((option) => option.getAttribute('value') === 'custom_openai')
    ).toBe(true);
    expect(within(providerSelect).queryByRole('option', { name: 'Amazon Bedrock' })).toBeNull();
  });

  it('preserves unavailable saved providers without offering them as new choices', async () => {
    vi.mocked(acpListProviderDetails).mockResolvedValue([
      {
        name: 'custom_openai',
        category: 'model',
        is_configured: true,
        provider_type: 'Custom',
        metadata: { display_name: 'Custom OpenAI endpoint', config_keys: [] },
      },
      {
        name: 'ollama_cloud',
        category: 'model',
        is_configured: true,
        provider_type: 'Builtin',
        metadata: { display_name: 'Old Ollama Cloud', config_keys: [] },
      },
    ] as never);
    vi.mocked(acpReadDefaults).mockResolvedValue({
      providerId: 'custom_openai',
      modelId: 'qwen3-coder',
    });
    vi.mocked(readCodeProModelRouting).mockResolvedValue(
      routingFor('ollama_cloud', 'legacy-model')
    );

    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });

    const selectedProvider = await screen.findByLabelText('Coding agent provider');
    expect(selectedProvider).toHaveDisplayValue('ollama_cloud');
    expect(within(selectedProvider).queryByRole('option', { name: 'Old Ollama Cloud' })).toBeNull();
    expect(saveCodeProModelRouting).not.toHaveBeenCalled();
  });

  it('shows every live model returned for Ollama Cloud', async () => {
    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });

    const modelSelect = await screen.findByLabelText('Coding agent model');
    await waitFor(() => expect(modelSelect).toHaveTextContent('kimi-k2.7-code'));
    expect(
      within(modelSelect)
        .getAllByRole('option')
        .map((option) => ({
          label: option.textContent,
          value: option.getAttribute('value') ?? '',
        }))
    ).toEqual([
      { label: 'Select a model', value: '' },
      { label: 'qwen3-coder', value: 'qwen3-coder' },
      { label: 'glm-5.2', value: 'glm-5.2' },
      { label: 'kimi-k2.7-code', value: 'kimi-k2.7-code' },
    ]);
  });

  it('keeps successful providers configurable when another provider is unavailable', async () => {
    vi.mocked(acpReadDefaults).mockResolvedValue({
      providerId: 'available-provider',
      modelId: 'live-account-model',
    });
    vi.mocked(acpListProviderDetails).mockResolvedValue([
      {
        name: 'available-provider',
        category: 'model',
        is_configured: true,
        provider_type: 'Custom',
        metadata: { display_name: 'Available Provider', config_keys: [] },
      },
      {
        name: 'offline-provider',
        category: 'model',
        is_configured: true,
        provider_type: 'Custom',
        metadata: { display_name: 'Offline Provider', config_keys: [] },
      },
    ] as never);
    vi.mocked(readCodeProModelRouting).mockResolvedValue(
      routingFor('available-provider', 'live-account-model')
    );
    vi.mocked(acpListProviderModels).mockImplementation(async (provider) => {
      if (provider === 'offline-provider') throw new Error('offline');
      return [
        {
          id: 'live-account-model',
          name: 'Live account model',
          contextLimit: 128_000,
          reasoning: true,
        },
      ];
    });

    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });

    const providerSelect = await screen.findByLabelText('Coding agent provider');
    await waitFor(() =>
      expect(
        within(providerSelect)
          .getAllByRole('option', { name: 'Available Provider' })
          .some((option) => option.getAttribute('value') === 'available-provider')
      ).toBe(true)
    );
    expect(
      within(providerSelect).queryByRole('option', {
        name: 'Offline Provider',
      })
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Apply recommended combination' })
    ).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeVisible();
    expect(screen.getByText('Available Provider: Available')).toBeVisible();
    expect(screen.getByText('Offline Provider: Temporarily unavailable')).toBeVisible();
  });

  it('publishes each provider result without waiting for the slowest provider', async () => {
    let resolveSlow!: (models: typeof liveModels) => void;
    vi.mocked(acpReadDefaults).mockResolvedValue({
      providerId: 'fast-provider',
      modelId: 'fast-model',
    });
    vi.mocked(acpListProviderDetails).mockResolvedValue([
      {
        name: 'fast-provider',
        category: 'model',
        is_configured: true,
        provider_type: 'Custom',
        metadata: { display_name: 'Fast Provider', config_keys: [] },
      },
      {
        name: 'slow-provider',
        category: 'model',
        is_configured: true,
        provider_type: 'Custom',
        metadata: { display_name: 'Slow Provider', config_keys: [] },
      },
    ] as never);
    vi.mocked(readCodeProModelRouting).mockResolvedValue(routingFor('fast-provider', 'fast-model'));
    vi.mocked(acpListProviderModels).mockImplementation((provider) => {
      if (provider === 'slow-provider') {
        return new Promise((resolve) => {
          resolveSlow = resolve;
        });
      }
      return Promise.resolve([
        { id: 'fast-model', name: 'Fast Model', contextLimit: 64_000, reasoning: false },
      ]);
    });

    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });

    const modelSelect = await screen.findByLabelText('Coding agent model');
    await waitFor(() => expect(modelSelect).toHaveTextContent('Fast Model'));
    expect(screen.getByText('Fast Provider: Available')).toBeVisible();
    expect(screen.getByText('Slow Provider: Loading models…')).toBeVisible();

    await act(async () => resolveSlow(liveModels));
    await waitFor(() => expect(screen.getByText('Slow Provider: Available')).toBeVisible());
  });

  it('preserves a saved model absent from discovery and rejects saving it with an explanation', async () => {
    const config = routingFor('ollama_cloud', 'glm-5.2');
    config.routes.find((route) => route.role === 'coder')!.modelId = 'account-private-model';
    vi.mocked(readCodeProModelRouting).mockResolvedValue(config);
    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });

    const model = await screen.findByLabelText('Coding agent model');
    await screen.findByText('Ollama Cloud: Available');
    expect(model).toHaveDisplayValue('account-private-model');
    fireEvent.click(screen.getByRole('button', { name: 'Save combination' }));
    expect(await screen.findByText(/Coding agent uses account-private-model/)).toBeVisible();
    expect(saveCodeProModelRouting).not.toHaveBeenCalled();
  });

  it('does not replace the other role selections when one saved model is unavailable', async () => {
    const config = routingFor('ollama_cloud', 'glm-5.2');
    config.routes = [
      { role: 'planner', providerId: 'ollama_cloud', modelId: 'qwen3-coder' },
      { role: 'coder', providerId: 'ollama_cloud', modelId: 'account-private-model' },
      { role: 'tester', providerId: 'ollama_cloud', modelId: 'glm-5.2' },
      { role: 'reviewer', providerId: 'ollama_cloud', modelId: 'kimi-k2.7-code' },
    ];
    vi.mocked(readCodeProModelRouting).mockResolvedValue(config);

    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });

    await screen.findByText('Ollama Cloud: Available');
    expect(screen.getByLabelText('Analysis agent model')).toHaveDisplayValue('qwen3-coder');
    expect(screen.getByLabelText('Coding agent model')).toHaveDisplayValue('account-private-model');
    expect(screen.getByLabelText('Review agent model')).toHaveDisplayValue('kimi-k2.7-code');
    expect(saveCodeProModelRouting).not.toHaveBeenCalled();
  });

  it('preserves an unavailable selected provider and allows discovery retry', async () => {
    vi.mocked(acpListProviderDetails).mockResolvedValue([
      {
        name: 'ollama_cloud',
        is_configured: true,
        provider_type: 'Custom',
        metadata: { display_name: 'Ollama Cloud', config_keys: [] },
      },
      {
        name: 'offline-provider',
        is_configured: true,
        provider_type: 'Custom',
        metadata: { display_name: 'Office Server', config_keys: [] },
      },
    ] as never);
    vi.mocked(readCodeProModelRouting).mockResolvedValue({
      version: 2,
      visionRoute: { enabled: false, mode: 'disabled' },
      advancedRoutingEnabled: true,
      routes: [
        { role: 'planner', providerId: 'ollama_cloud', modelId: 'qwen3-coder' },
        { role: 'coder', providerId: 'offline-provider', modelId: 'offline-model' },
        { role: 'tester', providerId: 'ollama_cloud', modelId: 'glm-5.2' },
        { role: 'reviewer', providerId: 'ollama_cloud', modelId: 'kimi-k2.7-code' },
      ],
      maxParallelCoders: 1,
    });
    vi.mocked(acpListProviderModels).mockImplementation(async (provider) => {
      if (provider === 'offline-provider') throw new Error('offline');
      return liveModels;
    });

    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });

    await screen.findByText('Office Server: Temporarily unavailable');
    expect(screen.getByLabelText('Coding agent provider')).toHaveValue('offline-provider');
    expect(screen.getByLabelText('Coding agent model')).toHaveDisplayValue('offline-model');
    expect(screen.getByLabelText('Analysis agent model')).toHaveDisplayValue('qwen3-coder');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
    const toggle = screen.getByRole('checkbox', { name: 'Enable advanced model routing' });
    fireEvent.click(toggle);
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(
      screen.queryByText('Failed to load models. Check the provider configuration.')
    ).not.toBeInTheDocument();
    fireEvent.click(toggle);
    await screen.findByText('Office Server: Temporarily unavailable');
    expect(screen.getByLabelText('Coding agent provider')).toHaveValue('offline-provider');
    expect(screen.getByLabelText('Coding agent model')).toHaveDisplayValue('offline-model');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
    expect(saveCodeProModelRouting).not.toHaveBeenCalled();
  });

  it('can save a disabled offline combination but cannot enable it without validation', async () => {
    const saved = routingFor('offline-provider', 'offline-model');
    saved.advancedRoutingEnabled = false;
    vi.mocked(readCodeProModelRouting).mockResolvedValue(saved);
    const onClose = vi.fn();
    render(<CodeProModelModal onClose={onClose} />, { wrapper: IntlTestWrapper });
    const toggle = await screen.findByRole('checkbox', { name: 'Enable advanced model routing' });
    expect(toggle).not.toBeChecked();
    expect(acpListProviderModels).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    await screen.findByText('Ollama Cloud: Available');
    fireEvent.click(screen.getByRole('button', { name: 'Save combination' }));
    expect(await screen.findByText(/no longer configured/)).toBeVisible();
    expect(saveCodeProModelRouting).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save combination' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    const disabled = vi.mocked(saveCodeProModelRouting).mock.calls[0][0];
    expect(disabled.advancedRoutingEnabled).toBe(false);
    expect(disabled.routes).toEqual(expect.arrayContaining(saved.routes));
  });

  it('preserves an all-role override when its connection becomes unavailable', async () => {
    vi.mocked(acpListProviderDetails).mockResolvedValue([
      {
        name: 'offline-provider',
        is_configured: true,
        provider_type: 'Custom',
        metadata: { display_name: 'Office Server', config_keys: [] },
      },
    ] as never);
    vi.mocked(acpReadDefaults).mockResolvedValue({
      providerId: 'offline-provider',
      modelId: 'offline-model',
    });
    vi.mocked(readCodeProModelRouting).mockResolvedValue(
      routingFor('offline-provider', 'offline-model')
    );
    vi.mocked(acpListProviderModels).mockRejectedValue(new Error('offline'));

    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });

    await screen.findByText('Office Server: Temporarily unavailable');
    expect(screen.getByLabelText('Coding agent model')).toHaveDisplayValue('offline-model');
    expect(saveCodeProModelRouting).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Save anyway' })).toBeNull();
  });

  it('does not allow a default draft to be saved before the catalog finishes loading', async () => {
    vi.mocked(acpListProviderDetails).mockReturnValue(new Promise(() => undefined));
    const config = routingFor('slow-catalog-provider', 'saved-coder-model');
    vi.mocked(readCodeProModelRouting).mockResolvedValue(config);

    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });

    expect(screen.getByRole('button', { name: 'Save combination' })).toBeDisabled();
    expect(screen.queryByLabelText('Coding agent model')).not.toBeInTheDocument();
    expect(acpListProviderModels).not.toHaveBeenCalled();
  });

  it('shows an explicit error and retries live discovery without a static UI fallback', async () => {
    vi.mocked(acpListProviderModels).mockRejectedValue(new Error('model discovery unavailable'));
    vi.mocked(readCodeProModelRouting).mockResolvedValue(null);
    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Enable advanced model routing' }));

    expect(
      await screen.findByText('Failed to load models. Check the provider configuration.')
    ).toBeInTheDocument();
    const modelSelect = screen.getByLabelText('Coding agent model');
    expect(
      within(modelSelect)
        .getAllByRole('option')
        .filter((option) => option.getAttribute('value') !== '')
        .map((option) => option.getAttribute('value'))
    ).toEqual(['glm-5.2']);

    vi.mocked(acpListProviderModels).mockResolvedValue(liveModels);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(modelSelect).toHaveTextContent('kimi-k2.7-code'));
    expect(
      screen.queryByText('Failed to load models. Check the provider configuration.')
    ).not.toBeInTheDocument();
  });

  it('shows a provider-specific retrying state while a retry is still running', async () => {
    let resolveRetry!: (models: typeof liveModels) => void;
    vi.mocked(acpListProviderModels)
      .mockRejectedValueOnce(new Error('model discovery unavailable'))
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveRetry = resolve;
        })
      );
    vi.mocked(readCodeProModelRouting).mockResolvedValue(null);
    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Enable advanced model routing' }));
    await screen.findByText('Failed to load models. Check the provider configuration.');
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(screen.getByText('Ollama Cloud: Retrying…')).toBeVisible();

    await act(async () => resolveRetry(liveModels));
    await waitFor(() => expect(screen.getByText('Ollama Cloud: Available')).toBeVisible());
  });

  it('treats an empty live result as a retryable discovery failure', async () => {
    vi.mocked(acpListProviderModels).mockResolvedValueOnce([]).mockResolvedValueOnce(liveModels);
    vi.mocked(readCodeProModelRouting).mockResolvedValue(null);
    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Enable advanced model routing' }));
    expect(
      await screen.findByText('Failed to load models. Check the provider configuration.')
    ).toBeInTheDocument();
    const modelSelect = screen.getByLabelText('Coding agent model');
    expect(within(modelSelect).queryByRole('option', { name: 'kimi-k2.7-code' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(modelSelect).toHaveTextContent('kimi-k2.7-code'));
    expect(acpListProviderModels).toHaveBeenCalledTimes(2);
  });

  it('does not allow editing or saving when the stored configuration cannot be read', async () => {
    let rejectConfig!: (error: Error) => void;
    vi.mocked(readCodeProModelRouting).mockReturnValue(
      new Promise((_, reject) => {
        rejectConfig = reject;
      })
    );
    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });

    expect(screen.getByRole('button', { name: 'Save combination' })).toBeDisabled();
    await act(async () => {
      rejectConfig(new Error('configuration unavailable'));
    });
    expect(
      await screen.findByText('Failed to load models. Check the provider configuration.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save combination' })).toBeDisabled();
    expect(acpListProviderModels).not.toHaveBeenCalled();
    expect(saveCodeProModelRouting).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('does not hide a loading explanation before the provider result arrives', async () => {
    let resolveModels!: (models: typeof liveModels) => void;
    vi.mocked(acpListProviderModels).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveModels = resolve;
      })
    );
    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });

    await waitFor(() => expect(acpListProviderModels).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Save combination' }));
    expect(
      await screen.findByText(
        'Models for Ollama Cloud are still loading. Wait a moment, then save again.'
      )
    ).toBeInTheDocument();
    expect(saveCodeProModelRouting).not.toHaveBeenCalled();

    resolveModels(liveModels);
    await waitFor(() =>
      expect(screen.getByLabelText('Coding agent model')).toHaveTextContent('kimi-k2.7-code')
    );
    expect(
      screen.getByText('Models for Ollama Cloud are still loading. Wait a moment, then save again.')
    ).toBeInTheDocument();
  });

  it('ignores a stale discovery response after a newer request wins', async () => {
    let resolveStaleModels!: (models: typeof liveModels) => void;
    vi.mocked(acpListProviderModels)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveStaleModels = resolve;
        })
      )
      .mockResolvedValueOnce(liveModels);
    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });

    await waitFor(() => expect(acpListProviderModels).toHaveBeenCalledTimes(1));
    const advanced = screen.getByRole('checkbox', { name: 'Enable advanced model routing' });
    fireEvent.click(advanced);
    fireEvent.click(advanced);

    await waitFor(() => expect(acpListProviderModels).toHaveBeenCalledTimes(2));
    const modelSelect = screen.getByLabelText('Coding agent model');
    await waitFor(() => expect(modelSelect).toHaveTextContent('kimi-k2.7-code'));

    await act(async () => {
      resolveStaleModels([]);
    });
    expect(modelSelect).toHaveTextContent('kimi-k2.7-code');
    expect(
      screen.queryByText('Failed to load models. Check the provider configuration.')
    ).not.toBeInTheDocument();
  });
  it('discovers auxiliary providers only after expanding advanced routes', async () => {
    const config = {
      ...routingFor('ollama_cloud', 'glm-5.2'),
      advancedRoutingEnabled: false,
      visionRoute: {
        enabled: true,
        mode: 'auto' as const,
        providerId: 'ollama_cloud',
        modelId: 'glm-5.2',
      },
    };
    vi.mocked(readCodeProModelRouting).mockResolvedValue(config);
    vi.mocked(acpListProviderDetails).mockResolvedValue(
      ['ollama_cloud', 'second'].map((name) => ({
        name,
        is_configured: true,
        provider_type: 'Custom',
        metadata: { display_name: name, config_keys: [] },
      })) as never
    );
    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });
    const toggle = await screen.findByRole('checkbox', { name: 'Enable advanced model routing' });
    expect(screen.queryByLabelText('Vision model')).not.toBeInTheDocument();
    expect(acpListProviderModels).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    await waitFor(() => expect(acpListProviderModels).toHaveBeenCalledWith('ollama_cloud'));
    const select = await screen.findByLabelText('Vision assistant agent provider');
    await waitFor(() => expect(screen.getByLabelText('Vision model')).toHaveTextContent('glm-5.2'));
    expect(within(select).getByRole('option', { name: 'second' })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'second' } });
    await waitFor(() => expect(acpListProviderModels).toHaveBeenCalledWith('second'));
    expect(screen.getByRole('checkbox', { name: 'Enable advanced model routing' })).toBeChecked();
  });
});
