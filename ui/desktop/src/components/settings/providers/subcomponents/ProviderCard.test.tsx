import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderDetails } from '../../../../types/providers';
import { IntlTestWrapper } from '../../../../i18n/test-utils';
import { ProviderCard } from './ProviderCard';

const disabledReason = 'Provider activation is disabled';
const disabledProvider: ProviderDetails = {
  name: 'nvidia',
  is_configured: true,
  provider_type: 'Declarative',
  metadata: {
    name: 'nvidia',
    display_name: 'NVIDIA',
    description: 'NVIDIA provider',
    default_model: 'fixture-model',
    model_doc_link: '',
    known_models: [],
    setup_steps: [],
    config_keys: [
      {
        name: 'NVIDIA_API_KEY',
        oauth_flow: false,
        primary: true,
        required: true,
        secret: true,
        credential_validation_supported: false,
        credential_validation_unavailable_reason: disabledReason,
      },
    ],
  },
};

describe('ProviderCard', () => {
  it('renders activation-disabled providers without configure or launch actions', async () => {
    const onConfigure = vi.fn();
    const onLaunch = vi.fn();
    const user = userEvent.setup();
    render(
      <ProviderCard
        provider={disabledProvider}
        onConfigure={onConfigure}
        onLaunch={onLaunch}
        isOnboarding={false}
      />,
      { wrapper: IntlTestWrapper }
    );

    await user.click(screen.getByTestId('provider-card-nvidia'));

    expect(screen.getByText(disabledReason)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Configure' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Launch' })).not.toBeInTheDocument();
    expect(onConfigure).not.toHaveBeenCalled();
    expect(onLaunch).not.toHaveBeenCalled();
  });
});
