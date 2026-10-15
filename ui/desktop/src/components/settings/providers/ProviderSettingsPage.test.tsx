import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { acpListProviderDetails } from '../../../acp/providers';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import type { ProviderDetails } from '../../../types/providers';
import ProviderSettings from './ProviderSettingsPage';

vi.mock('../../../acp/providers', () => ({
  acpListProviderDetails: vi.fn(),
}));

vi.mock('./ProviderGrid', () => ({
  default: ({ providers }: { providers: ProviderDetails[] }) => (
    <div data-testid="provider-grid">{providers.map((provider) => provider.name).join(',')}</div>
  ),
}));

const provider = (
  name: string,
  providerType: ProviderDetails['provider_type'],
  isConfigured = true
): ProviderDetails => ({
  name,
  provider_type: providerType,
  is_configured: isConfigured,
  category: 'model',
  metadata: {
    name,
    display_name: name,
    description: '',
    default_model: '',
    known_models: [],
    model_doc_link: '',
    config_keys: [],
  },
});

describe('ProviderSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows only saved custom connections so the full page matches the settings summary', async () => {
    vi.mocked(acpListProviderDetails).mockResolvedValue([
      provider('saved-local', 'Custom'),
      provider('amazon_bedrock', 'Builtin'),
      provider('unfinished-custom', 'Custom', false),
    ]);

    render(
      <MemoryRouter>
        <IntlTestWrapper>
          <ProviderSettings onClose={vi.fn()} isOnboarding={false} />
        </IntlTestWrapper>
      </MemoryRouter>
    );

    await waitFor(() =>
      expect(screen.getByTestId('provider-grid')).toHaveTextContent('saved-local')
    );
    expect(screen.getByTestId('provider-grid')).not.toHaveTextContent('amazon_bedrock');
    expect(screen.getByTestId('provider-grid')).not.toHaveTextContent('unfinished-custom');
  });
});
