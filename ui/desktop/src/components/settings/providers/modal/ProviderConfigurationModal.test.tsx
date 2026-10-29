import { IntlProvider } from 'react-intl';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acpReadProviderConfig,
  acpSaveProviderConfig,
  acpDeleteProviderConfig,
} from '../../../../acp/providers';
import type { ProviderDetails } from '../../../../types/providers';
import ProviderConfigurationModal from './ProviderConfigurationModal';

vi.mock('../../../../acp/providers', () => ({
  acpAuthenticateProvider: vi.fn(),
  acpDeleteCustomProvider: vi.fn(),
  acpDeleteProviderConfig: vi.fn(),
  acpReadProviderConfig: vi.fn(),
  acpSaveProviderConfig: vi.fn(),
}));

vi.mock('../../../ModelAndProviderContext', () => ({
  useModelAndProvider: () => ({
    refreshCurrentModelAndProvider: vi.fn().mockResolvedValue(undefined),
    getCurrentModelAndProvider: vi.fn().mockResolvedValue({
      model: 'gpt-4o',
      provider: 'openai',
    }),
  }),
}));

const openai: ProviderDetails = {
  name: 'openai',
  is_configured: true,
  provider_type: 'Builtin',
  metadata: {
    name: 'openai',
    display_name: 'OpenAI',
    description: 'OpenAI',
    default_model: 'gpt-4o',
    model_doc_link: '',
    known_models: [],
    setup_steps: [],
    config_keys: [
      {
        name: 'OPENAI_HOST',
        required: true,
        secret: false,
        default: 'https://api.openai.com',
        oauth_flow: false,
        primary: true,
        credential_validation_supported: true,
        credential_validation_unavailable_reason: null,
      },
      {
        name: 'OPENAI_BASE_URL',
        required: false,
        secret: false,
        oauth_flow: false,
        primary: true,
        credential_validation_supported: true,
        credential_validation_unavailable_reason: null,
      },
    ],
  },
};

describe('ProviderConfigurationModal OpenAI endpoint selector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(acpReadProviderConfig).mockResolvedValue([
      { key: 'OPENAI_HOST', required: true, isSecret: false, isSet: false, value: null },
      {
        key: 'OPENAI_BASE_URL',
        required: false,
        isSecret: false,
        isSet: true,
        value: 'http://127.0.0.1:3000/v1',
      },
    ]);
    vi.mocked(acpSaveProviderConfig).mockResolvedValue(undefined);
  });

  it('submits the persisted custom base URL without requiring OPENAI_HOST', async () => {
    const onConfigured = vi.fn();
    const user = userEvent.setup();
    render(
      <IntlProvider locale="en" defaultLocale="en">
        <ProviderConfigurationModal
          provider={openai}
          onClose={vi.fn()}
          onConfigured={onConfigured}
        />
      </IntlProvider>
    );

    await waitFor(() =>
      expect(screen.getByDisplayValue('http://127.0.0.1:3000/v1')).toBeInTheDocument()
    );
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() =>
      expect(acpSaveProviderConfig).toHaveBeenCalledWith(
        'openai',
        [{ key: 'OPENAI_BASE_URL', value: 'http://127.0.0.1:3000/v1' }],
        ['OPENAI_HOST']
      )
    );
    expect(onConfigured).toHaveBeenCalledWith(openai);
  });

  it.each([false, true])(
    'uses the delete receipt instead of the saved default to decide success (reject=%s)',
    async (rejected) => {
      if (rejected)
        vi.mocked(acpDeleteProviderConfig).mockRejectedValueOnce(new Error('active task'));
      else vi.mocked(acpDeleteProviderConfig).mockResolvedValueOnce(undefined);
      const onClose = vi.fn();
      const user = userEvent.setup();
      render(
        <IntlProvider locale="en">
          <ProviderConfigurationModal provider={openai} onClose={onClose} />
        </IntlProvider>
      );
      await user.click(await screen.findByRole('button', { name: 'Delete Provider' }));
      await user.click(screen.getByRole('button', { name: 'Confirm Delete' }));
      expect(acpDeleteProviderConfig).toHaveBeenCalledWith('openai');
      if (rejected) {
        expect(await screen.findByRole('alert')).toHaveTextContent(
          'Could not delete this connection'
        );
        expect(onClose).not.toHaveBeenCalled();
      } else await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    }
  );
});
