import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { acpListProviderDetails } from '../../../acp/providers';
import type { ProviderDetails } from '../../../types/providers';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import { fetchModelsForProviders } from '../../settings/models/modelInterface';
import { RecipeModelSelector } from './RecipeModelSelector';

vi.mock('../../../acp/providers', () => ({
  acpListProviderDetails: vi.fn(),
}));

vi.mock('../../settings/models/modelInterface', () => ({
  fetchModelsForProviders: vi.fn(),
}));

describe('RecipeModelSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchModelsForProviders).mockResolvedValue([]);
  });

  it('does not discover models for activation-disabled configured providers', async () => {
    const disabledProvider = providerDetails('nvidia', false);
    const enabledProvider = providerDetails('ollama_cloud', true);
    vi.mocked(acpListProviderDetails).mockResolvedValue([disabledProvider, enabledProvider]);

    render(<RecipeModelSelector onProviderChange={vi.fn()} onModelChange={vi.fn()} />, {
      wrapper: IntlTestWrapper,
    });

    await waitFor(() => expect(fetchModelsForProviders).toHaveBeenCalledWith([enabledProvider]));
  });
});

function providerDetails(name: string, activationEnabled: boolean): ProviderDetails {
  return {
    name,
    is_configured: true,
    provider_type: 'Declarative',
    metadata: {
      name,
      display_name: name,
      description: '',
      default_model: '',
      model_doc_link: '',
      known_models: [],
      setup_steps: [],
      config_keys: activationEnabled
        ? []
        : [
            {
              name: 'API_KEY',
              oauth_flow: false,
              primary: true,
              required: true,
              secret: true,
              credential_validation_supported: false,
              credential_validation_unavailable_reason: 'Provider activation is disabled',
            },
          ],
    },
  };
}
