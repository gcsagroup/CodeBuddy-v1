import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderDetails } from '../../../../types/providers';
import { IntlTestWrapper } from '../../../../i18n/test-utils';
import { ProviderCard } from './ProviderCard';
import { acpSetProviderEnabled } from '../../../../acp/providers';
vi.mock('../../../../acp/providers', () => ({ acpSetProviderEnabled: vi.fn() }));

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
  it('uses persisted disabled state after reopening and later provider updates', async () => {
    const props = { provider: { ...disabledProvider, provider_type: 'Custom' as const, enabled: false, metadata: { ...disabledProvider.metadata, config_keys: [] } }, onConfigure: vi.fn(), onLaunch: vi.fn(), isOnboarding: false };
    const view = render(<ProviderCard {...props} />, { wrapper: IntlTestWrapper });
    expect(screen.getByRole('switch')).not.toBeChecked();
    view.rerender(<ProviderCard {...props} provider={{ ...props.provider, enabled: true }} />);
    expect(screen.getByRole('switch')).toBeChecked();
  });
  it('toggles a connection without opening configuration and retains state on failure', async () => {
    const configure = vi.fn(), changed = vi.fn();
    vi.mocked(acpSetProviderEnabled).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Busy'));
    render(<ProviderCard provider={{ ...disabledProvider, provider_type: 'Custom', metadata: { ...disabledProvider.metadata, config_keys: [] } }} onConfigure={configure} onLaunch={() => {}} isOnboarding={false} onEnabledChanged={changed} />, { wrapper: IntlTestWrapper });
    const toggle = screen.getByRole('switch', { name: 'NVIDIA connection' });
    await userEvent.click(toggle);
    expect(acpSetProviderEnabled).toHaveBeenCalledWith('nvidia', false);
    expect(toggle).not.toBeChecked();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(configure).not.toHaveBeenCalled();
    await userEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(screen.getByRole('alert')).toBeVisible();
  });
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
