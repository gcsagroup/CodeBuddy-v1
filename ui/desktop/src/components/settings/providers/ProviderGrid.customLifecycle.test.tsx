import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import type { ProviderDetails } from '../../../types/providers';
import ProviderGrid from './ProviderGrid';

const providerApi = vi.hoisted(() => ({
  get: vi.fn(),
  discover: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  create: vi.fn(),
}));

vi.mock('../../../acp/providers', () => ({
  acpGetCustomProvider: providerApi.get,
  acpDiscoverCustomProviderModels: providerApi.discover,
  acpUpdateCustomProviderFromRequest: providerApi.update,
  acpDeleteCustomProvider: providerApi.remove,
  acpCreateCustomProviderFromRequest: providerApi.create,
}));

vi.mock('../../ModelAndProviderContext', () => ({
  useModelAndProvider: () => ({
    getCurrentModelAndProvider: vi.fn().mockResolvedValue({
      provider: 'another-provider',
      model: 'another-model',
    }),
  }),
}));

vi.mock('../models/subcomponents/SwitchModelModal', () => ({
  SwitchModelModal: ({
    initialProvider,
    initialModel,
  }: {
    initialProvider: string;
    initialModel?: string;
  }) => (
    <div role="dialog" data-initial-model={initialModel}>
      Choose model for {initialProvider}
    </div>
  ),
}));

const customProvider: ProviderDetails = {
  name: 'custom_office_local',
  is_configured: true,
  provider_type: 'Custom',
  metadata: {
    name: 'custom_office_local',
    display_name: 'Office local model',
    description: 'Local model connection',
    default_model: 'qwen3:8b',
    model_doc_link: '',
    known_models: [],
    setup_steps: [],
    config_keys: [],
  },
};

describe('ProviderGrid custom provider lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerApi.get.mockResolvedValue({
      editable: true,
      provider: {
        providerId: 'custom_office_local',
        engine: 'ollama_compatible',
        displayName: 'Office local model',
        apiUrl: 'http://127.0.0.1:11434',
        models: ['qwen3:8b'],
        supportsStreaming: true,
        requiresAuth: false,
        apiKeySet: false,
        headers: {},
      },
    });
    providerApi.discover.mockResolvedValue(['qwen3:8b']);
    providerApi.update.mockResolvedValue({});
    providerApi.remove.mockResolvedValue({});
  });

  it('waits for the saved card inventory before closing, without opening model selection', async () => {
    const user = userEvent.setup();
    let finishRefresh!: () => void;
    const refreshProviders = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        })
    );
    render(
      <ProviderGrid
        providers={[customProvider]}
        isOnboarding={false}
        compactConnectionSetup
        refreshProviders={refreshProviders}
      />,
      { wrapper: IntlTestWrapper }
    );

    await user.click(screen.getByTestId('provider-card-custom_office_local'));
    expect(await screen.findByText('Edit Provider')).toBeInTheDocument();
    expect(screen.getByText('Local Ollama')).toBeInTheDocument();

    const updateButton = screen.getByRole('button', { name: 'Update Provider' });
    expect(updateButton).toBeEnabled();
    await user.click(updateButton);
    expect(providerApi.discover).not.toHaveBeenCalled();
    expect(providerApi.update).toHaveBeenCalledWith(
      'custom_office_local',
      expect.objectContaining({
        engine: 'ollama_compatible',
        models: ['qwen3:8b'],
      })
    );
    expect(refreshProviders).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Edit Provider')).toBeInTheDocument();
    await act(async () => finishRefresh());
    await waitFor(() => expect(screen.queryByText('Edit Provider')).not.toBeInTheDocument());
    expect(screen.queryByText('Choose model for custom_office_local')).not.toBeInTheDocument();
  });

  it('saves the verified model and closes configuration without another model dialog', async () => {
    providerApi.discover.mockResolvedValue(['gemini-3.6-flash', 'ollama-dev']);
    providerApi.create.mockResolvedValue({ provider_name: 'custom_new_gateway' });
    const user = userEvent.setup();
    const refreshProviders = vi.fn();
    render(
      <ProviderGrid
        providers={[]}
        isOnboarding={false}
        compactConnectionSetup
        refreshProviders={refreshProviders}
      />,
      {
        wrapper: IntlTestWrapper,
      }
    );
    await user.click(screen.getByTestId('add-custom-provider-card'));
    await user.click(screen.getByRole('combobox', { name: 'Provider Type' }));
    await user.click(screen.getByRole('option', { name: 'Local Ollama' }));
    await user.click(screen.getByRole('button', { name: 'Load models' }));
    await user.selectOptions(await screen.findByLabelText('Discovered models'), 'ollama-dev');
    await user.click(screen.getByRole('button', { name: 'Create Provider' }));
    expect(providerApi.create).toHaveBeenCalledWith(
      expect.objectContaining({
        models: ['ollama-dev', 'gemini-3.6-flash'],
      })
    );
    expect(refreshProviders).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Create Provider' })).not.toBeInTheDocument();
    expect(screen.queryByText('Choose model for custom_new_gateway')).not.toBeInTheDocument();
  });

  it('deletes an inactive custom connection after the explicit confirmation', async () => {
    const user = userEvent.setup();
    const refreshProviders = vi.fn();
    render(
      <ProviderGrid
        providers={[customProvider]}
        isOnboarding={false}
        compactConnectionSetup
        refreshProviders={refreshProviders}
      />,
      { wrapper: IntlTestWrapper }
    );

    await user.click(screen.getByTestId('provider-card-custom_office_local'));
    await user.click(await screen.findByRole('button', { name: 'Delete Provider' }));
    await user.click(screen.getByRole('button', { name: 'Confirm Delete' }));

    expect(providerApi.remove).toHaveBeenCalledWith('custom_office_local');
    expect(refreshProviders).toHaveBeenCalledTimes(1);
  });
});
