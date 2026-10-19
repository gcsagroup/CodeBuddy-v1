import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acpListProviderDetails as list,
  acpCreateCustomProviderFromRequest as create,
  acpDiscoverCustomProviderModels as discover,
  acpSaveDefaults as save,
} from '../../acp/providers';
import type { ProviderDetails } from '../../types/providers';
import { IntlTestWrapper } from '../../i18n/test-utils';
import OnboardingGuard from './OnboardingGuard';

const configure = vi.fn();
vi.mock('../../acp/providers', () => ({
  acpListProviderDetails: vi.fn(),
  acpCreateCustomProviderFromRequest: vi.fn(),
  acpDiscoverCustomProviderModels: vi.fn(),
  acpSaveDefaults: vi.fn(),
}));
const connection: ProviderDetails = {
  name: 'custom_user',
  is_configured: true,
  provider_type: 'Custom',
  metadata: {
    name: 'custom_user',
    display_name: 'My models',
    description: '',
    default_model: 'model-a',
    model_doc_link: '',
    known_models: [{ name: 'model-a', context_limit: 0 }],
    config_keys: [],
    setup_steps: [],
  },
};
function guard(requireModel = true) {
  return (
    <StrictMode>
      <IntlTestWrapper>
        <OnboardingGuard onConfigure={configure} requireModel={requireModel}>
          <div>chat</div>
        </OnboardingGuard>
      </IntlTestWrapper>
    </StrictMode>
  );
}

describe('manual model onboarding', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(list).mockResolvedValue([]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('keeps a fresh installation empty and opens settings only at the user request', async () => {
    render(guard());
    expect(await screen.findByText('Connect a model to get started')).toBeInTheDocument();
    expect(screen.queryByText('chat')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(configure).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open model settings' }));
    expect(configure).toHaveBeenCalledOnce();
  });

  it('allows a saved connection without choosing a global default model first', async () => {
    vi.mocked(list).mockResolvedValue([connection]);
    render(guard());
    expect(await screen.findByText('chat')).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it('does not treat a connection missing required credentials as configured', async () => {
    vi.mocked(list).mockResolvedValue([{ ...connection, is_configured: false }]);
    render(guard());
    expect(await screen.findByText('Connect a model to get started')).toBeInTheDocument();
    expect(screen.queryByText('chat')).not.toBeInTheDocument();
  });

  it('retries an inventory failure without creating a default connection', async () => {
    vi.mocked(list).mockRejectedValueOnce(new Error('offline')).mockResolvedValue([connection]);
    render(guard());
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('chat')).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
    expect(discover).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('keeps settings reachable while a single StrictMode inventory request is pending', async () => {
    let finish!: (providers: ProviderDetails[]) => void;
    vi.mocked(list).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const view = render(guard());
    expect(screen.getByRole('status')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open model settings' }));
    expect(configure).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledTimes(1);
    view.rerender(guard(false));
    expect(screen.getByText('chat')).toBeInTheDocument();
    await act(async () => finish([]));
    expect(screen.getByText('chat')).toBeInTheDocument();
  });

  it('does not check settings, and refreshes connections when returning to chat', async () => {
    const view = render(guard(false));
    expect(screen.getByText('chat')).toBeInTheDocument();
    expect(list).not.toHaveBeenCalled();
    view.rerender(guard());
    await screen.findByText('Connect a model to get started');
    view.rerender(guard(false));
    vi.mocked(list).mockResolvedValue([connection]);
    view.rerender(guard());
    expect(await screen.findByText('chat')).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });
});
