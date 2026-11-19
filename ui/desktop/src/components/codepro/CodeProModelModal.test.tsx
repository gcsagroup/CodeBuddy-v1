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
  acpCreateCustomProviderFromRequest,
  acpDiscoverCustomProviderModels,
} from '../../acp/providers';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { CodeProModelModal } from './CodeProModelModal';
import { resolveModelCapability } from '../../acp/modelCapabilities';

it('adds a custom image connection inside the vision dialog without navigating to provider settings', async () => {
  vi.mocked(readCodeProModelRouting).mockResolvedValue(null);
  const configure = vi.fn();
  render(<CodeProModelModal visionOnly onClose={vi.fn()} onConfigureProvider={configure} />, {
    wrapper: IntlTestWrapper,
  });
  fireEvent.click(await screen.findByRole('switch', { name: 'Use a custom image model' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Add an image model connection' }));
  expect(screen.getByLabelText(/^API URL/)).toBeVisible();
  expect(screen.getByLabelText(/^API Key/)).toBeVisible();
  expect(configure).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0]);
  expect(
    await screen.findByRole('button', { name: 'Add an image model connection' })
  ).toBeVisible();
});

vi.mock('../../acp/modelCapabilities', () => ({
  resolveModelCapability: vi.fn(async (providerId: string, modelId: string) => ({
    providerId,
    modelId,
    imageInput: 'supported',
    source: 'provider_metadata',
  })),
}));

vi.mock('../../acp/codeproModelRouting', () => ({
  DISABLED_CODEPRO_MODEL_ROUTING: {
    version: 2,
    advancedRoutingEnabled: false,
    routes: [],
    visionRoute: { enabled: false, mode: 'disabled' },
    maxParallelCoders: 1,
  },
  readCodeProModelRouting: vi.fn().mockResolvedValue(null),
  saveCodeProModelRouting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../acp/providers', () => ({
  acpCreateCustomProviderFromRequest: vi.fn(),
  acpDiscoverCustomProviderModels: vi.fn(),
  acpListProviderDetails: vi.fn().mockResolvedValue([
    {
      name: 'ollama_cloud',
      is_configured: true,
      provider_type: 'Custom',
      metadata: { display_name: 'Ollama Cloud' },
    },
  ]),
  acpListProviderModels: vi
    .fn()
    .mockResolvedValue([
      { id: 'kimi-k2.7-code' },
      { id: 'qwen3-coder' },
      { id: 'glm-5.2' },
      { id: 'deepseek-v3' },
    ]),
  acpReadDefaults: vi.fn().mockResolvedValue({
    providerId: 'ollama_cloud',
    modelId: 'glm-5.2',
  }),
}));

describe('CodeProModelModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readCodeProModelRouting).mockResolvedValue(null);
    vi.mocked(acpReadDefaults).mockResolvedValue({
      providerId: 'ollama_cloud',
      modelId: 'glm-5.2',
    });
    vi.mocked(saveCodeProModelRouting).mockResolvedValue(undefined);
  });

  it('preserves the independent vision route when advanced routing is toggled and saved', async () => {
    const visionRoute = {
      enabled: true,
      mode: 'always' as const,
      providerId: 'ollama_cloud',
      modelId: 'qwen3-coder',
    };
    vi.mocked(readCodeProModelRouting).mockResolvedValue({
      version: 2,
      advancedRoutingEnabled: false,
      routes: [],
      visionRoute,
      maxParallelCoders: 1,
    });
    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });
    const toggle = await screen.findByRole('checkbox', { name: 'Enable advanced model routing' });
    expect(screen.getByText('Backup image model')).toBeInTheDocument();
    expect(screen.getByText('Ollama Cloud / qwen3-coder')).toBeInTheDocument();
    expect(screen.queryByLabelText('Image model')).not.toBeInTheDocument();
    expect(acpListProviderModels).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    expect(screen.getByLabelText('Backup image model provider')).toHaveValue('ollama_cloud');
    expect(screen.getByLabelText('Image model')).toHaveValue('qwen3-coder');
    await waitFor(() =>
      expect(screen.getByLabelText('Image model')).toHaveTextContent('qwen3-coder')
    );
    fireEvent.click(toggle);
    expect(screen.queryByLabelText('Image model')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByLabelText('Image model')).toHaveValue('qwen3-coder');
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save combination' }));
    await waitFor(() =>
      expect(saveCodeProModelRouting).toHaveBeenCalledWith(
        expect.objectContaining({ advancedRoutingEnabled: false, visionRoute })
      )
    );
  });

  it('persists the typed routing contract consumed by the next scheduler run', async () => {
    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Enable advanced model routing' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Testing agent model')).toHaveDisplayValue('glm-5.2')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save combination' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save anyway' }));

    await waitFor(() =>
      expect(saveCodeProModelRouting).toHaveBeenCalledWith({
        version: 2,
        advancedRoutingEnabled: true,
        routes: [
          { role: 'main', providerId: 'ollama_cloud', modelId: 'glm-5.2' },
          { role: 'planner', providerId: 'ollama_cloud', modelId: 'glm-5.2' },
          { role: 'coder', providerId: 'ollama_cloud', modelId: 'glm-5.2' },
          { role: 'tester', providerId: 'ollama_cloud', modelId: 'glm-5.2' },
          { role: 'reviewer', providerId: 'ollama_cloud', modelId: 'glm-5.2' },
        ],
        visionRoute: { enabled: false, mode: 'disabled' },
        maxParallelCoders: 1,
      })
    );
  });

  it('leaves auxiliary vision disabled until a provider and model are selected', async () => {
    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Enable advanced model routing' }));
    const provider = screen.getByLabelText('Backup image model provider');
    const model = screen.getByLabelText('Image model');
    expect(provider).toHaveValue('');
    expect(provider).toHaveDisplayValue('Not configured (disabled)');
    expect(model).toHaveValue('');
    expect(model).toHaveDisplayValue('Select model');
    expect(model).toBeDisabled();
    await waitFor(() => expect(provider).toHaveTextContent('Ollama Cloud'));
    fireEvent.change(provider, { target: { value: 'ollama_cloud' } });
    await waitFor(() => expect(model).not.toBeDisabled());
    await waitFor(() => expect(model).toHaveTextContent('qwen3-coder'));
    fireEvent.change(model, { target: { value: 'qwen3-coder' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save combination' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save anyway' }));

    await waitFor(() =>
      expect(saveCodeProModelRouting).toHaveBeenCalledWith({
        version: 2,
        advancedRoutingEnabled: true,
        routes: [
          { role: 'main', providerId: 'ollama_cloud', modelId: 'glm-5.2' },
          { role: 'planner', providerId: 'ollama_cloud', modelId: 'glm-5.2' },
          { role: 'coder', providerId: 'ollama_cloud', modelId: 'glm-5.2' },
          { role: 'tester', providerId: 'ollama_cloud', modelId: 'glm-5.2' },
          { role: 'reviewer', providerId: 'ollama_cloud', modelId: 'glm-5.2' },
        ],
        visionRoute: {
          enabled: true,
          mode: 'auto',
          providerId: 'ollama_cloud',
          modelId: 'qwen3-coder',
        },
        maxParallelCoders: 1,
      })
    );
  });

  it('follows the global provider and model while dormant role overrides stay disabled', async () => {
    vi.mocked(readCodeProModelRouting).mockResolvedValue({
      version: 2,
      advancedRoutingEnabled: false,
      routes: [],
      visionRoute: { enabled: false, mode: 'disabled' },
      maxParallelCoders: 1,
    });
    vi.mocked(acpReadDefaults).mockResolvedValue({
      providerId: 'ollama_cloud',
      modelId: 'kimi-k2.7-code',
    });

    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });

    const advanced = await screen.findByRole('checkbox', {
      name: 'Enable advanced model routing',
    });
    expect(advanced).not.toBeChecked();
    for (const role of ['Analysis agent', 'Coding agent', 'Testing agent', 'Review agent']) {
      expect(screen.queryByLabelText(`${role} provider`)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(`${role} model`)).not.toBeInTheDocument();
    }
    expect(screen.queryByLabelText('Maximum parallel coding agents')).not.toBeInTheDocument();
    expect(readCodeProModelRouting).toHaveBeenCalledTimes(1);
    expect(
      screen.getAllByText('Follows current model: Ollama Cloud / kimi-k2.7-code')
    ).toHaveLength(5);
    expect(screen.queryByText(/^Default/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save combination' }));
    await waitFor(() =>
      expect(saveCodeProModelRouting).toHaveBeenCalledWith({
        version: 2,
        advancedRoutingEnabled: false,
        routes: ['main', 'planner', 'coder', 'tester', 'reviewer'].map((role) => ({
          role,
          providerId: 'ollama_cloud',
          modelId: 'kimi-k2.7-code',
        })),
        visionRoute: { enabled: false, mode: 'disabled' },
        maxParallelCoders: 1,
      })
    );
  });

  it('does not claim qualification when qualification evidence is missing', async () => {
    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });

    expect(await screen.findByText('Analysis agent')).toBeInTheDocument();
    expect(screen.getByText('Coding agent')).toBeInTheDocument();
    expect(screen.getByText('Testing agent')).toBeInTheDocument();
    expect(screen.getByText('Review agent')).toBeInTheDocument();
    expect(screen.queryByText(/qualified/i)).not.toBeInTheDocument();
    expect(screen.getAllByText('Follows current model: Ollama Cloud / glm-5.2')).toHaveLength(5);
  });

  it('uses the current session pair as the single authority shown while advanced routing is off', async () => {
    render(
      <CodeProModelModal
        onClose={vi.fn()}
        currentDefault={{ provider: 'ollama_cloud', model: 'deepseek-v3' }}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(
      await screen.findAllByText('Follows current model: Ollama Cloud / deepseek-v3')
    ).toHaveLength(5);
    expect(acpReadDefaults).not.toHaveBeenCalled();
  });

  it('does not claim qualification for an advanced non-authorized model', async () => {
    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Enable advanced model routing' }));
    const model = screen.getByLabelText('Coding agent model');
    await waitFor(() => expect(model).toHaveTextContent('qwen3-coder'));
    fireEvent.change(model, { target: { value: 'qwen3-coder' } });

    expect(model).toHaveDisplayValue('qwen3-coder');
    expect(screen.queryByText(/qualified/i)).not.toBeInTheDocument();
  });

  it('starts from the current default instead of replaying saved role routes when enabled', async () => {
    vi.mocked(readCodeProModelRouting).mockResolvedValue({
      version: 2,
      advancedRoutingEnabled: false,
      routes: [],
      visionRoute: { enabled: false, mode: 'disabled' },
      maxParallelCoders: 1,
    });
    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Enable advanced model routing' }));

    expect(screen.queryByLabelText('Maximum parallel coding agents')).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Analysis agent provider')).toBeEnabled();
    for (const role of ['Analysis agent', 'Coding agent', 'Testing agent', 'Review agent']) {
      expect(screen.getByLabelText(`${role} provider`)).toHaveDisplayValue('Ollama Cloud');
      expect(screen.getByLabelText(`${role} model`)).toHaveDisplayValue('glm-5.2');
    }
    expect(readCodeProModelRouting).toHaveBeenCalledTimes(1);
    expect(acpListProviderModels).toHaveBeenCalled();
  });

  it('restores and persists the typed routing contract with serialized coding', async () => {
    const config = {
      version: 2 as const,
      advancedRoutingEnabled: true,
      routes: [
        { role: 'planner' as const, providerId: 'ollama_cloud', modelId: 'glm-5.2' },
        { role: 'coder' as const, providerId: 'ollama_cloud', modelId: 'qwen3-coder' },
        { role: 'tester' as const, providerId: 'ollama_cloud', modelId: 'kimi-k2.7-code' },
        { role: 'reviewer' as const, providerId: 'ollama_cloud', modelId: 'deepseek-v3' },
      ],
      visionRoute: { enabled: false, mode: 'disabled' as const },
      maxParallelCoders: 1,
    };
    vi.mocked(readCodeProModelRouting).mockResolvedValue(config);
    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });

    expect(
      await screen.findByRole('checkbox', { name: 'Enable advanced model routing' })
    ).toBeChecked();
    expect(screen.queryByLabelText('Maximum parallel coding agents')).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText('Coding agent model')).toHaveDisplayValue('qwen3-coder')
    );
    expect(
      screen.getByText('Actual model: Ollama Cloud / qwen3-coder · Separate setting')
    ).toBeVisible();
    expect(screen.queryByLabelText('Maximum parallel coding agents')).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save combination' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save anyway' }));
    await waitFor(() =>
      expect(saveCodeProModelRouting).toHaveBeenCalledWith({
        ...config,
        routes: [
          { role: 'main', providerId: 'ollama_cloud', modelId: 'glm-5.2' },
          ...config.routes,
        ],
      })
    );
  });

  it('allows model editing only after advanced routing is enabled', async () => {
    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Enable advanced model routing' }));

    const model = screen.getByLabelText('Coding agent model');
    await waitFor(() => expect(model).toHaveTextContent('qwen3-coder'));
    fireEvent.change(model, { target: { value: 'qwen3-coder' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save combination' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save anyway' }));

    await waitFor(() => expect(saveCodeProModelRouting).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveCodeProModelRouting).mock.calls[0][0].routes).toContainEqual({
      role: 'coder',
      providerId: 'ollama_cloud',
      modelId: 'qwen3-coder',
    });
  });

  it('puts the main agent first and restores its own model independently of analysis', async () => {
    const config = {
      version: 2 as const,
      visionRoute: { enabled: false, mode: 'disabled' as const },
      advancedRoutingEnabled: true,
      maxParallelCoders: 1,
      routes: [
        { role: 'main' as const, providerId: 'ollama_cloud', modelId: 'deepseek-v3' },
        { role: 'planner' as const, providerId: 'ollama_cloud', modelId: 'glm-5.2' },
        { role: 'coder' as const, providerId: 'ollama_cloud', modelId: 'qwen3-coder' },
        { role: 'tester' as const, providerId: 'ollama_cloud', modelId: 'kimi-k2.7-code' },
        { role: 'reviewer' as const, providerId: 'ollama_cloud', modelId: 'glm-5.2' },
      ],
    };
    vi.mocked(readCodeProModelRouting).mockResolvedValue(config);
    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });
    await waitFor(() =>
      expect(screen.getByLabelText('Main agent model')).toHaveDisplayValue('deepseek-v3')
    );
    expect(screen.getByLabelText('Analysis agent model')).toHaveDisplayValue('glm-5.2');
    expect(screen.getAllByRole('combobox')[0]).toHaveAccessibleName('Main agent provider');
    fireEvent.click(screen.getByRole('button', { name: 'Save combination' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save anyway' }));
    await waitFor(() => expect(saveCodeProModelRouting).toHaveBeenCalledWith(config));
  });

  it('offers connection setup at the bottom of each configured-provider selector', async () => {
    const onConfigureProvider = vi.fn();
    render(<CodeProModelModal onClose={vi.fn()} onConfigureProvider={onConfigureProvider} />, {
      wrapper: IntlTestWrapper,
    });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Enable advanced model routing' }));

    const provider = screen.getByLabelText('Coding agent provider');
    await waitFor(() => expect(provider).toHaveTextContent('Ollama Cloud'));
    expect(within(provider).getByRole('option', { name: 'Use another provider…' })).toBeVisible();
    fireEvent.change(provider, { target: { value: '__configure_provider__' } });

    expect(onConfigureProvider).toHaveBeenCalledTimes(1);
  });

  it('warns before saving an advanced duplicate model combination', async () => {
    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Enable advanced model routing' }));

    for (const role of ['Analysis agent', 'Coding agent']) {
      const model = screen.getByLabelText(`${role} model`);
      await waitFor(() => expect(model).toHaveTextContent('glm-5.2'));
      fireEvent.change(model, { target: { value: 'glm-5.2' } });
    }
    fireEvent.click(screen.getByRole('button', { name: 'Save combination' }));

    expect(await screen.findByText(/use the same model glm-5.2/)).toBeInTheDocument();
    expect(saveCodeProModelRouting).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save anyway' }));
    await waitFor(() => expect(saveCodeProModelRouting).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveCodeProModelRouting).mock.calls[0][0].routes).toContainEqual({
      role: 'coder',
      providerId: 'ollama_cloud',
      modelId: 'glm-5.2',
    });
  });

  it.each(['saved', 'edited'] as const)(
    'preserves every provider/model in the %s combination across off/on toggles',
    async (source) => {
      const providers = await acpListProviderDetails();
      vi.mocked(acpListProviderDetails).mockResolvedValueOnce([
        ...providers,
        {
          ...providers[0],
          name: 'second',
          metadata: { ...providers[0].metadata, display_name: 'Second' },
        },
      ]);
      const config: CodeProModelRoutingConfig = {
        version: 2,
        visionRoute: { enabled: false, mode: 'disabled' },
        advancedRoutingEnabled: true,
        maxParallelCoders: 1,
        routes: [
          { role: 'main', providerId: 'second', modelId: 'deepseek-v3' },
          { role: 'planner', providerId: 'ollama_cloud', modelId: 'glm-5.2' },
          { role: 'coder', providerId: 'second', modelId: 'qwen3-coder' },
          { role: 'tester', providerId: 'ollama_cloud', modelId: 'kimi-k2.7-code' },
          { role: 'reviewer', providerId: 'second', modelId: 'glm-5.2' },
        ],
      };
      const labels = [
        'Main agent',
        'Analysis agent',
        'Coding agent',
        'Testing agent',
        'Review agent',
      ];
      if (source === 'saved') vi.mocked(readCodeProModelRouting).mockResolvedValue(config);
      render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });
      const toggle = await screen.findByRole('checkbox', { name: 'Enable advanced model routing' });
      if (source === 'edited') fireEvent.click(toggle);
      await screen.findByText('Second: Available');
      if (source === 'edited') {
        config.routes.forEach((route, index) => {
          fireEvent.change(screen.getByLabelText(`${labels[index]} provider`), {
            target: { value: route.providerId },
          });
          fireEvent.change(screen.getByLabelText(`${labels[index]} model`), {
            target: { value: route.modelId },
          });
        });
      }
      for (let cycle = 0; cycle < 2; cycle += 1) {
        fireEvent.click(toggle);
        expect(screen.queryByLabelText('Main agent model')).not.toBeInTheDocument();
        expect(screen.getAllByText('Follows current model: Ollama Cloud / glm-5.2')).toHaveLength(
          5
        );
        fireEvent.click(toggle);
        await screen.findByText('Second: Available');
        config.routes.forEach((route, index) => {
          expect(screen.getByLabelText(`${labels[index]} provider`)).toHaveValue(route.providerId);
          expect(screen.getByLabelText(`${labels[index]} model`)).toHaveValue(route.modelId);
        });
      }
      expect(saveCodeProModelRouting).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Save combination' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Save anyway' }));
      await waitFor(() => expect(saveCodeProModelRouting).toHaveBeenCalledExactlyOnceWith(config));
    }
  );

  it('does not persist a draft when toggled and cancelled', async () => {
    const onClose = vi.fn();
    render(<CodeProModelModal onClose={onClose} />, { wrapper: IntlTestWrapper });
    const toggle = await screen.findByRole('checkbox', { name: 'Enable advanced model routing' });
    fireEvent.click(toggle);
    await screen.findByText('Ollama Cloud: Available');
    fireEvent.change(screen.getByLabelText('Main agent model'), {
      target: { value: 'deepseek-v3' },
    });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(saveCodeProModelRouting).not.toHaveBeenCalled();
  });

  it('retains the draft after save failure and disables routing only on an explicit save', async () => {
    const onClose = vi.fn();
    vi.mocked(saveCodeProModelRouting).mockRejectedValueOnce(new Error('save unavailable'));
    render(<CodeProModelModal onClose={onClose} />, { wrapper: IntlTestWrapper });
    const toggle = await screen.findByRole('checkbox', { name: 'Enable advanced model routing' });
    fireEvent.click(toggle);
    await screen.findByText('Ollama Cloud: Available');
    fireEvent.change(screen.getByLabelText('Main agent model'), {
      target: { value: 'deepseek-v3' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save combination' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save anyway' }));
    await screen.findByText('Failed to save. Try again later.');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Main agent model')).toHaveValue('deepseek-v3');
    fireEvent.click(toggle);
    expect(screen.queryByText('Failed to save. Try again later.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save anyway' })).not.toBeInTheDocument();
    expect(saveCodeProModelRouting).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Save combination' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(saveCodeProModelRouting).toHaveBeenLastCalledWith({
      version: 2,
      visionRoute: { enabled: false, mode: 'disabled' },
      advancedRoutingEnabled: false,
      routes: vi.mocked(saveCodeProModelRouting).mock.calls[0][0].routes,
      maxParallelCoders: 1,
    });
  });

  it('restores the saved combination after disabling, saving and reopening with a new default', async () => {
    const onClose = vi.fn();
    const view = render(<CodeProModelModal onClose={onClose} />, { wrapper: IntlTestWrapper });
    const toggle = await screen.findByRole('checkbox', { name: 'Enable advanced model routing' });
    fireEvent.click(toggle);
    await screen.findByText('Ollama Cloud: Available');
    fireEvent.change(screen.getByLabelText('Main agent model'), {
      target: { value: 'deepseek-v3' },
    });
    fireEvent.change(screen.getByLabelText('Coding agent model'), {
      target: { value: 'qwen3-coder' },
    });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save combination' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    const saved = vi.mocked(saveCodeProModelRouting).mock.calls[0][0];
    expect(saved.advancedRoutingEnabled).toBe(false);
    expect(saved.routes).toContainEqual({
      role: 'main',
      providerId: 'ollama_cloud',
      modelId: 'deepseek-v3',
    });
    view.unmount();
    vi.mocked(readCodeProModelRouting).mockResolvedValue(saved);
    vi.mocked(acpListProviderModels).mockClear();
    render(
      <CodeProModelModal
        onClose={vi.fn()}
        currentDefault={{ provider: 'ollama_cloud', model: 'kimi-k2.7-code' }}
      />,
      { wrapper: IntlTestWrapper }
    );
    const reopenedToggle = await screen.findByRole('checkbox', {
      name: 'Enable advanced model routing',
    });
    expect(reopenedToggle).not.toBeChecked();
    expect(
      screen.getAllByText('Follows current model: Ollama Cloud / kimi-k2.7-code')
    ).toHaveLength(5);
    expect(acpListProviderModels).not.toHaveBeenCalled();
    fireEvent.click(reopenedToggle);
    await screen.findByText('Ollama Cloud: Available');
    expect(screen.getByLabelText('Main agent model')).toHaveValue('deepseek-v3');
    expect(screen.getByLabelText('Coding agent model')).toHaveValue('qwen3-coder');
    expect(screen.getByLabelText('Analysis agent model')).toHaveValue('glm-5.2');
    fireEvent.click(screen.getByRole('button', { name: 'Save combination' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save anyway' }));
    await waitFor(() =>
      expect(saveCodeProModelRouting).toHaveBeenLastCalledWith({
        ...saved,
        advancedRoutingEnabled: true,
      })
    );
  });

  it('keeps an unsaved selection across parent rerenders with the same default pair', async () => {
    const onClose = vi.fn();
    const view = render(
      <CodeProModelModal
        onClose={onClose}
        currentDefault={{ provider: 'ollama_cloud', model: 'glm-5.2' }}
      />,
      { wrapper: IntlTestWrapper }
    );
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Enable advanced model routing' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Main agent model')).toHaveTextContent('deepseek-v3')
    );
    fireEvent.change(screen.getByLabelText('Main agent model'), {
      target: { value: 'deepseek-v3' },
    });
    view.rerender(
      <CodeProModelModal
        onClose={onClose}
        currentDefault={{ provider: 'ollama_cloud', model: 'glm-5.2' }}
      />
    );
    expect(screen.getByLabelText('Main agent model')).toHaveDisplayValue('deepseek-v3');
    expect(readCodeProModelRouting).toHaveBeenCalledTimes(1);
    expect(saveCodeProModelRouting).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save combination' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save anyway' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(vi.mocked(saveCodeProModelRouting).mock.calls[0][0].routes).toContainEqual({
      role: 'main',
      providerId: 'ollama_cloud',
      modelId: 'deepseek-v3',
    });
    const saved = vi.mocked(saveCodeProModelRouting).mock.calls[0][0];
    view.unmount();
    vi.mocked(readCodeProModelRouting).mockResolvedValue(saved);
    render(<CodeProModelModal onClose={vi.fn()} />, { wrapper: IntlTestWrapper });
    expect(await screen.findByLabelText('Main agent model')).toHaveDisplayValue('deepseek-v3');
    await screen.findByText('Ollama Cloud: Available');
    expect(screen.getByLabelText('Analysis agent model')).toHaveDisplayValue('glm-5.2');
    expect(saveCodeProModelRouting).toHaveBeenCalledTimes(1);
  });
});

it('keeps auxiliary vision editable without reviving or overwriting legacy role routing', async () => {
  const saved: CodeProModelRoutingConfig = {
    version: 2,
    advancedRoutingEnabled: false,
    routes: [{ role: 'reviewer', providerId: 'ollama_cloud', modelId: 'legacy-review' }],
    visionRoute: {
      enabled: true,
      mode: 'auto',
      providerId: 'ollama_cloud',
      modelId: 'qwen3-coder',
    },
    maxParallelCoders: 1,
  };
  vi.mocked(acpListProviderDetails).mockResolvedValue([
    {
      name: 'ollama_cloud',
      is_configured: true,
      provider_type: 'Custom',
      metadata: { display_name: 'Ollama Cloud' },
    },
  ] as Awaited<ReturnType<typeof acpListProviderDetails>>);
  vi.mocked(acpListProviderModels).mockResolvedValue([
    { id: 'qwen3-coder', name: 'Qwen coder' },
    { id: 'vision-two', name: 'Vision two' },
  ]);
  vi.mocked(readCodeProModelRouting).mockResolvedValue(saved);
  vi.mocked(saveCodeProModelRouting).mockClear().mockResolvedValue();
  render(<CodeProModelModal visionOnly onClose={vi.fn()} />, { wrapper: IntlTestWrapper });
  const model = await screen.findByRole('radio', { name: 'Vision two' });
  expect(screen.getByRole('switch', { name: 'Use a custom image model' })).toBeChecked();
  expect(
    screen.queryByRole('checkbox', { name: 'Enable advanced model routing' })
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Review agent model')).not.toBeInTheDocument();
  fireEvent.click(model);
  fireEvent.click(screen.getByRole('button', { name: 'Save vision settings' }));
  await waitFor(() =>
    expect(saveCodeProModelRouting).toHaveBeenCalledWith({
      ...saved,
      visionRoute: { ...saved.visionRoute, modelId: 'vision-two' },
    })
  );
});

it('offers only confirmed image models and keeps the selection when backend validation rejects a save', async () => {
  vi.mocked(acpListProviderDetails).mockResolvedValue([
    {
      name: 'vision-provider',
      is_configured: true,
      provider_type: 'Custom',
      metadata: { display_name: 'Vision connection' },
    },
  ] as Awaited<ReturnType<typeof acpListProviderDetails>>);
  vi.mocked(acpListProviderModels).mockResolvedValue([
    { id: 'image-model', name: 'Can read images' },
    { id: 'text-model', name: 'Text only' },
    { id: 'unknown-model', name: 'Unknown capability' },
  ]);
  vi.mocked(resolveModelCapability).mockImplementation(async (providerId, modelId) => ({
    providerId,
    modelId,
    imageInput:
      modelId === 'image-model'
        ? 'supported'
        : modelId === 'text-model'
          ? 'unsupported'
          : 'unknown',
    source: 'provider_metadata',
  }));
  vi.mocked(readCodeProModelRouting).mockResolvedValue(null);
  const close = vi.fn();
  render(<CodeProModelModal visionOnly onClose={close} />, { wrapper: IntlTestWrapper });
  fireEvent.click(await screen.findByRole('switch', { name: 'Use a custom image model' }));
  const model = await screen.findByRole('radio', { name: 'Can read images' });
  expect(screen.queryByRole('radio', { name: 'Text only' })).not.toBeInTheDocument();
  expect(screen.queryByRole('radio', { name: 'Unknown capability' })).not.toBeInTheDocument();
  fireEvent.click(model);
  vi.mocked(saveCodeProModelRouting).mockRejectedValueOnce(
    Object.assign(new Error('所选备用模型尚未确认支持图片，请选择支持图片的模型。'), {
      data: { kind: 'vision_error', reason: 'image_not_supported' },
    })
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save vision settings' }));
  expect(
    await screen.findByText('所选备用模型尚未确认支持图片，请选择支持图片的模型。')
  ).toBeVisible();
  expect(model).toBeChecked();
  expect(close).not.toHaveBeenCalled();
});

it('uses the LAN image default with the switch off, distinguishes equal ids and returns to the distribution default on save', async () => {
  const saved = {
    version: 2 as const,
    advancedRoutingEnabled: false,
    routes: [],
    maxParallelCoders: 1,
    visionRoute: { enabled: true, mode: 'auto' as const, providerId: 'other', modelId: 'shared' },
  };
  vi.mocked(readCodeProModelRouting).mockResolvedValue(saved);
  vi.mocked(acpReadDefaults).mockResolvedValue({
    providerId: 'custom_codebuddy_lan',
    modelId: 'text',
  });
  vi.mocked(acpListProviderDetails).mockResolvedValue(
    ['custom_codebuddy_lan', 'other'].map((name) => ({
      name,
      is_configured: true,
      provider_type: 'Custom',
      metadata: { display_name: name },
    })) as Awaited<ReturnType<typeof acpListProviderDetails>>
  );
  vi.mocked(acpListProviderModels).mockResolvedValue([
    { id: 'shared', name: 'shared' },
    {
      id: 'CUA-S1-Qwen3.5-4B',
      name: 'CUA-S1-Qwen3.5-4B',
    },
  ]);
  vi.mocked(resolveModelCapability).mockImplementation(async (providerId, modelId) => ({
    providerId,
    modelId,
    imageInput: 'supported',
    source: 'provider_metadata',
  }));
  vi.mocked(saveCodeProModelRouting).mockClear().mockResolvedValue();
  render(<CodeProModelModal visionOnly onClose={vi.fn()} />, { wrapper: IntlTestWrapper });
  const other = await screen.findByRole('group', { name: 'other' });
  expect(within(other).getByRole('radio', { name: 'shared' })).toBeChecked();
  const primary = screen.getByRole('group', { name: 'custom_codebuddy_lan' });
  fireEvent.click(within(primary).getByRole('radio', { name: 'shared' }));
  expect(within(other).getByRole('radio', { name: 'shared' })).not.toBeChecked();
  fireEvent.click(screen.getByRole('switch', { name: 'Use a custom image model' }));
  await waitFor(() =>
    expect(screen.queryByText('Checking image support…')).not.toBeInTheDocument()
  );
  expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  expect(screen.getByText('Uses the default image model')).toBeVisible();
  expect(screen.queryByText(/Default: CUA-S1-Qwen3.5-4B/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Save vision settings' }));
  await waitFor(() =>
    expect(saveCodeProModelRouting).toHaveBeenCalledWith({
      ...saved,
      visionRoute: {
        enabled: true,
        mode: 'always',
        providerId: 'custom_codebuddy_lan',
        modelId: 'CUA-S1-Qwen3.5-4B',
      },
    })
  );
});

it('does not claim unavailable while image capabilities are loading and preserves an unknown saved choice', async () => {
  vi.mocked(readCodeProModelRouting).mockResolvedValue({
    version: 2,
    advancedRoutingEnabled: false,
    routes: [],
    maxParallelCoders: 1,
    visionRoute: { enabled: true, mode: 'auto', providerId: 'one', modelId: 'saved' },
  });
  vi.mocked(acpListProviderDetails).mockResolvedValue([
    {
      name: 'one',
      is_configured: true,
      provider_type: 'Custom',
      metadata: { display_name: 'One' },
    },
  ] as Awaited<ReturnType<typeof acpListProviderDetails>>);
  vi.mocked(acpListProviderModels).mockResolvedValue([{ id: 'saved', name: 'saved' }]);
  let finish!: (value: Awaited<ReturnType<typeof resolveModelCapability>>) => void;
  vi.mocked(resolveModelCapability).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  vi.mocked(saveCodeProModelRouting).mockClear();
  render(<CodeProModelModal visionOnly onClose={vi.fn()} />, { wrapper: IntlTestWrapper });
  await waitFor(() => expect(resolveModelCapability).toHaveBeenCalledWith('one', 'saved'));
  expect(screen.getByText('Checking image support…')).toBeVisible();
  expect(screen.queryByText(/not confirmed/)).not.toBeInTheDocument();
  await act(async () =>
    finish({
      providerId: 'one',
      modelId: 'saved',
      imageInput: 'unknown',
      source: 'provider_metadata',
    })
  );
  expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  expect(screen.getByText('Image support not confirmed: saved')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Save vision settings' }));
  expect(saveCodeProModelRouting).not.toHaveBeenCalled();
});

it('does not turn the first model from a newly created connection into an image model', async () => {
  vi.clearAllMocks();
  const provider = {
    name: 'plain-connection',
    is_configured: true,
    provider_type: 'Custom',
    metadata: { display_name: 'Plain connection' },
  } as Awaited<ReturnType<typeof acpListProviderDetails>>[number];
  vi.mocked(acpListProviderDetails).mockResolvedValue([provider]);
  vi.mocked(acpListProviderModels).mockResolvedValue([{ id: 'plain-chat', name: 'plain-chat' }]);
  vi.mocked(resolveModelCapability).mockImplementation(async (providerId, modelId) => ({
    providerId,
    modelId,
    imageInput: 'unsupported',
    source: 'provider_metadata',
  }));
  vi.mocked(readCodeProModelRouting).mockResolvedValue(null);
  vi.mocked(acpDiscoverCustomProviderModels).mockResolvedValue(['plain-chat']);
  vi.mocked(acpCreateCustomProviderFromRequest).mockResolvedValue({ provider_name: 'new-plain' });
  render(<CodeProModelModal visionOnly onClose={vi.fn()} />, { wrapper: IntlTestWrapper });
  fireEvent.click(await screen.findByRole('switch', { name: 'Use a custom image model' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Add an image model connection' }));
  fireEvent.change(screen.getByLabelText(/^API URL/), {
    target: { value: 'https://fixture.invalid' },
  });
  fireEvent.change(screen.getByLabelText(/^API Key/), {
    target: { value: 'fixture-not-a-real-key' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
  await screen.findByLabelText('Discovered models');
  vi.mocked(acpListProviderDetails).mockResolvedValueOnce([
    provider,
    { ...provider, name: 'new-plain' },
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'Verify and add' }));
  await screen.findByRole('button', { name: 'Add an image model connection' });
  expect(acpCreateCustomProviderFromRequest).toHaveBeenCalledOnce();
  expect(screen.queryByRole('radio', { name: 'plain-chat' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Save vision settings' }));
  expect(
    await screen.findByText('Choose both a provider and model for Backup image model.')
  ).toBeVisible();
  expect(saveCodeProModelRouting).not.toHaveBeenCalled();
});
