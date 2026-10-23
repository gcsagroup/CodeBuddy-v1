import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { acpListProviderDetails } from '../../../acp/providers';
import ModelsAndRuntimeSettings from './ModelsAndRuntimeSettings';

vi.mock('../../../i18n', () => ({
  currentLocale: 'en',
  defineMessages: <T,>(messages: T) => messages,
  useIntl: () => ({
    locale: 'en',
    formatMessage: (message: { defaultMessage: string }) => message.defaultMessage,
  }),
}));

vi.mock('../../../acp/providers', () => ({
  acpListProviderDetails: vi.fn(),
  acpListProviderModels: vi.fn().mockResolvedValue([]),
}));

vi.mock('./ModelsSection', () => ({
  default: ({ showProviderConfiguration }: { showProviderConfiguration?: boolean }) => (
    <div>
      current-model-settings
      <span data-testid="provider-configuration-visibility">
        {showProviderConfiguration === false ? 'hidden' : 'visible'}
      </span>
    </div>
  ),
}));
vi.mock('../../../acp/config', () => ({
  acpReadConfig: vi.fn().mockResolvedValue(null),
  acpUpsertConfig: vi.fn(),
}));
vi.mock('../providers/ProviderGrid', () => ({
  default: function ProviderGridFixture({
    providers,
    refreshProviders,
  }: {
    providers: Array<{ name: string }>;
    refreshProviders: () => Promise<void>;
  }) {
    const [selectionOpen, setSelectionOpen] = useState(false);
    return (
      <div data-testid="custom-provider-grid">
        {providers.map((provider) => provider.name).join(',')}
        <button
          onClick={async () => {
            await refreshProviders();
            setSelectionOpen(true);
          }}
        >
          Save connection
        </button>
        {selectionOpen && <div role="dialog">Choose saved model</div>}
      </div>
    );
  },
}));

const customProvider = {
  category: 'model' as const,
  is_configured: true,
  metadata: {
    config_keys: [],
    default_model: 'local-model',
    description: 'Self-hosted endpoint',
    display_name: 'Studio endpoint',
    known_models: [],
    model_doc_link: '',
    name: 'studio',
  },
  name: 'studio',
  provider_type: 'Custom' as const,
};

const vendorProvider = {
  ...customProvider,
  name: 'vendor',
  provider_type: 'Builtin' as const,
};

const unfinishedCustomProvider = {
  ...customProvider,
  name: 'unfinished-custom',
  is_configured: false,
};

describe('ModelsAndRuntimeSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(acpListProviderDetails).mockResolvedValue([
      vendorProvider,
      unfinishedCustomProvider,
      customProvider,
    ]);
  });

  it('shows only first-party and custom connection choices in the settings page', async () => {
    render(<ModelsAndRuntimeSettings setView={vi.fn()} />);

    expect(screen.getByText('CodeBuddy model')).toBeInTheDocument();
    expect(screen.getByText('In development')).toBeInTheDocument();
    expect(screen.getByText('Custom model connections')).toBeInTheDocument();
    expect(screen.getByTestId('provider-configuration-visibility')).toHaveTextContent('hidden');
    await waitFor(() =>
      expect(screen.getByTestId('custom-provider-grid')).toHaveTextContent('studio')
    );
    expect(screen.getByTestId('custom-provider-grid')).not.toHaveTextContent('vendor');
    expect(screen.getByTestId('custom-provider-grid')).toHaveTextContent('unfinished-custom');
    expect(
      screen.getByRole('combobox', { name: 'explorer · Workspace exploration Model connection' })
    ).not.toHaveTextContent('unfinished-custom');
  });

  it('replaces the local download console with agent model configuration', () => {
    render(<ModelsAndRuntimeSettings setView={vi.fn()} />);

    expect(screen.queryByText('Model console')).not.toBeInTheDocument();
    expect(screen.queryByText('Built-in local model management')).not.toBeInTheDocument();
    expect(screen.getByText('Subagent templates and models')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Configure agent models' })
    ).not.toBeInTheDocument();
  });

  it('does not restore the GGUF console through the old deep-link state', () => {
    render(<ModelsAndRuntimeSettings setView={vi.fn()} />);

    expect(screen.queryByText('local-runtime-console')).not.toBeInTheDocument();
    expect(screen.getByText('Subagent templates and models')).toBeInTheDocument();
  });

  it.each([false, true])(
    'preserves model selection through catalog refresh (failure: %s)',
    async (fails) => {
      render(<ModelsAndRuntimeSettings setView={vi.fn()} />);
      await screen.findByTestId('custom-provider-grid');
      let finishRefresh!: () => void;
      vi.mocked(acpListProviderDetails).mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finishRefresh = () =>
              fails ? reject(new Error('temporary catalog failure')) : resolve([customProvider]);
          })
      );
      fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
      expect(screen.getByTestId('custom-provider-grid')).toBeInTheDocument();
      await act(async () => finishRefresh());
      expect(await screen.findByRole('dialog')).toHaveTextContent('Choose saved model');
      if (fails) {
        expect(
          screen.getByText(
            'Custom connections could not be loaded. Your saved configuration was not changed.'
          )
        ).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await waitFor(() =>
          expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
        );
        expect(screen.getByRole('dialog')).toHaveTextContent('Choose saved model');
      }
    }
  );
});
