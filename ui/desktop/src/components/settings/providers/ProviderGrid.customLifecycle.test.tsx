import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import type { ProviderDetails } from '../../../types/providers';
import ProviderGrid from './ProviderGrid';
import { toast } from 'react-toastify';

const providerApi = vi.hoisted(() => ({
  get: vi.fn(),
  discover: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  create: vi.fn(),
  refreshDefaults: vi.fn(),
  saveDefaults: vi.fn(),
}));

vi.mock('../../../acp/providers', () => ({
  acpGetCustomProvider: providerApi.get,
  acpDiscoverCustomProviderModels: providerApi.discover,
  acpUpdateCustomProviderFromRequest: providerApi.update,
  acpDeleteCustomProvider: providerApi.remove,
  acpCreateCustomProviderFromRequest: providerApi.create,
  acpSaveDefaults: providerApi.saveDefaults,
}));

vi.mock('../../ModelAndProviderContext', () => ({
  useModelAndProvider: () => ({
    getCurrentModelAndProvider: vi.fn().mockResolvedValue({
      provider: 'custom_office_local',
      model: 'qwen3:8b',
    }),
    refreshCurrentModelAndProvider: providerApi.refreshDefaults,
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

  it('opens an unconfigured cloud preset for credentials without activating a model', async () => {
    providerApi.get.mockResolvedValueOnce({
      editable: true,
      provider: {
        providerId: customProvider.name,
        engine: 'openai_compatible',
        displayName: 'ollama',
        apiUrl: 'https://ollama.com',
        models: ['kimi-k3'],
        supportsStreaming: true,
        requiresAuth: true,
        apiKeySet: false,
        headers: {},
      },
    });
    const user = userEvent.setup();
    render(
      <ProviderGrid
        providers={[{ ...customProvider, is_configured: false }]}
        isOnboarding={false}
        compactConnectionSetup
      />,
      { wrapper: IntlTestWrapper }
    );
    await user.click(screen.getByTestId('provider-card-custom_office_local'));
    expect(await screen.findByText('Edit Provider')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://ollama.com')).toBeInTheDocument();
    expect(screen.queryByText('Choose model for custom_office_local')).not.toBeInTheDocument();
    expect(providerApi.update).not.toHaveBeenCalled();
    expect(providerApi.create).not.toHaveBeenCalled();
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

    const updateButton = screen.getByRole('button', { name: 'Verify and save' });
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
    expect(providerApi.refreshDefaults).toHaveBeenCalledTimes(1);
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
    await user.click(screen.getByRole('button', { name: 'Verify and add' }));
    expect(providerApi.create).toHaveBeenCalledWith(
      expect.objectContaining({
        models: ['ollama-dev', 'gemini-3.6-flash'],
      })
    );
    expect(refreshProviders).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Verify and add' })).not.toBeInTheDocument();
    expect(screen.queryByText('Choose model for custom_new_gateway')).not.toBeInTheDocument();
  });

  it('uses the verified connection selection as the new conversation default', async () => {
    providerApi.discover.mockResolvedValue(['qwen3:8b', 'cyber-model']);
    const user = userEvent.setup();
    render(<ProviderGrid providers={[customProvider]} isOnboarding={false} compactConnectionSetup />, { wrapper: IntlTestWrapper });
    await user.click(screen.getByTestId('provider-card-custom_office_local'));
    await user.click(screen.getByRole('button', { name: 'Load models' }));
    await user.selectOptions(await screen.findByLabelText('Discovered models'), 'cyber-model');
    await user.click(screen.getByRole('button', { name: 'Verify and save' }));
    await waitFor(() => expect(providerApi.saveDefaults).toHaveBeenCalledWith(customProvider.name, 'cyber-model'));
    expect(providerApi.update.mock.invocationCallOrder[0]).toBeLessThan(providerApi.saveDefaults.mock.invocationCallOrder[0]);
    expect(providerApi.saveDefaults.mock.invocationCallOrder[0]).toBeLessThan(providerApi.refreshDefaults.mock.invocationCallOrder[0]);
  });

  it('numbers default names against all connections and preserves a user-entered name', async () => {
    const user = userEvent.setup();
    const providers = ['Custom connection', ' custom CONNECTION 2 ', 'Local Ollama'].map(
      (name, index) => ({
        ...customProvider,
        name: `custom-${index}`,
        metadata: { ...customProvider.metadata, display_name: name },
      })
    );
    render(<ProviderGrid providers={providers} isOnboarding={false} compactConnectionSetup />, {
      wrapper: IntlTestWrapper,
    });
    await user.type(screen.getByTestId('provider-search-input'), 'not-a-match');
    await user.click(screen.getByTestId('add-custom-provider-card'));
    const name = screen.getByRole('textbox', { name: 'Display Name' });
    expect(name).toHaveValue('Custom connection 3');
    await user.click(screen.getByRole('combobox', { name: 'Provider Type' }));
    await user.click(screen.getByRole('option', { name: 'Local Ollama' }));
    expect(name).toHaveValue('Local Ollama 2');
    await user.clear(name);
    await user.type(name, 'My chosen name');
    await user.click(screen.getByRole('combobox', { name: 'Provider Type' }));
    await user.click(screen.getByRole('option', { name: 'OpenAI-compatible API' }));
    expect(name).toHaveValue('My chosen name');
    expect(providerApi.create).not.toHaveBeenCalled();
  });

  it('keeps a failed verification in the form without creating a card or closing the dialog', async () => {
    const user = userEvent.setup();
    const refreshProviders = vi.fn();
    providerApi.create.mockRejectedValueOnce({ error: { message: 'PRIVATE_ECHOED_KEY', data: {
      code: 'custom_provider_model_unavailable', httpStatus: 404, upstreamCode: 'model_not_found',
    } } });
    render(<ProviderGrid providers={[]} isOnboarding={false} compactConnectionSetup refreshProviders={refreshProviders} />, { wrapper: IntlTestWrapper });
    await user.click(screen.getByTestId('add-custom-provider-card'));
    await user.click(screen.getByRole('combobox', { name: 'Provider Type' }));
    await user.click(screen.getByRole('option', { name: 'Local Ollama' }));
    await user.click(screen.getByRole('button', { name: 'Load models' }));
    await user.click(screen.getByRole('button', { name: 'Verify and add' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Verification failed');
    expect(alert).toHaveTextContent('The connection was not saved');
    expect(alert).toHaveTextContent('Verify the API address, base path and model ID');
    expect(alert).not.toHaveTextContent('PRIVATE_ECHOED_KEY');
    await user.click(screen.getByText('Diagnostic details'));
    expect(alert).toHaveTextContent('HTTP 404');
    expect(alert).toHaveTextContent('model_not_found');
    expect(refreshProviders).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'API URL' })).toHaveValue('http://127.0.0.1:11434');
    expect(screen.getByLabelText('Discovered models')).toHaveValue('qwen3:8b');
    expect(screen.getByRole('button', { name: 'Verify and add' })).toBeEnabled();
  });

  it('does not report verification failure when only refreshing the saved connection fails', async () => {
    const warning = vi.spyOn(toast, 'warning').mockReturnValue('refresh-warning');
    try {
      const user = userEvent.setup();
      providerApi.create.mockResolvedValueOnce({ provider_name: 'saved-connection' });
      const refreshProviders = vi.fn().mockRejectedValue(new Error('Refresh unavailable'));
      render(<ProviderGrid providers={[]} isOnboarding={false} compactConnectionSetup refreshProviders={refreshProviders} />, { wrapper: IntlTestWrapper });
      await user.click(screen.getByTestId('add-custom-provider-card'));
      await user.click(screen.getByRole('combobox', { name: 'Provider Type' }));
      await user.click(screen.getByRole('option', { name: 'Local Ollama' }));
      await user.click(screen.getByRole('button', { name: 'Load models' }));
      await user.click(screen.getByRole('button', { name: 'Verify and add' }));
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('Connection verified and saved'));
      expect(screen.queryByRole('button', { name: 'Verify and add' })).not.toBeInTheDocument();
      expect(screen.queryByText('Verification failed')).not.toBeInTheDocument();
    } finally { warning.mockRestore(); }
  });

  it('deletes a saved default connection after confirmation without requiring the old settings selector', async () => {
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
    expect(providerApi.refreshDefaults).toHaveBeenCalledTimes(1);
    expect(refreshProviders).toHaveBeenCalledTimes(1);
  });

  it('keeps the connection form and displays an error when deletion is rejected', async () => {
    providerApi.remove.mockRejectedValueOnce(new Error('active provider'));
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
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not delete this connection');
    expect(screen.getByRole('alert')).not.toHaveTextContent('Verification failed');
    expect(screen.getByText('Edit Provider')).toBeInTheDocument();
    expect(providerApi.refreshDefaults).not.toHaveBeenCalled();
    expect(refreshProviders).not.toHaveBeenCalled();
  });

  it('does not report deletion failure after a successful delete when refreshing defaults fails', async () => {
    const warning = vi.spyOn(toast, 'warning').mockReturnValue('delete-refresh-warning');
    try {
      providerApi.refreshDefaults.mockRejectedValueOnce(new Error('refresh failed'));
      const user = userEvent.setup();
      render(<ProviderGrid providers={[customProvider]} isOnboarding={false} compactConnectionSetup />, { wrapper: IntlTestWrapper });
      await user.click(screen.getByTestId('provider-card-custom_office_local'));
      await user.click(await screen.findByRole('button', { name: 'Delete Provider' }));
      await user.click(screen.getByRole('button', { name: 'Confirm Delete' }));
      await waitFor(() => expect(screen.queryByText('Edit Provider')).not.toBeInTheDocument());
      expect(providerApi.remove).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('Connection deleted'));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    } finally { warning.mockRestore(); }
  });
});
