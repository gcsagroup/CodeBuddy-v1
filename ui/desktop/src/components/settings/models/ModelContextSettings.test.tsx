import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, it, expect } from 'vitest';
import ModelContextSettings from './ModelContextSettings';
import type { ProviderDetails } from '../../../types/providers';
import { acpReadProviderConfig, acpSaveProviderConfig } from '../../../acp/providers';
vi.mock('../../../i18n', () => ({ useIntl: () => ({ locale: 'en' }) }));
vi.mock('../../../acp/providers', () => ({
  acpReadProviderConfig: vi.fn(),
  acpSaveProviderConfig: vi.fn(),
}));
it('shows unknown capacity honestly and saves or clears only the selected model', async () => {
  vi.mocked(acpReadProviderConfig).mockResolvedValue([
    {
      key: 'contextWindow:one',
      value: JSON.stringify({ configured: null, contextWindow: 32768, contextSource: 'fallback' }),
      isSet: false,
      isSecret: false,
      required: false,
    },
  ]);
  vi.mocked(acpSaveProviderConfig).mockResolvedValue();
  const providers = [
    { name: 'p', metadata: { display_name: 'LAN', known_models: [{ name: 'one' }] } },
  ] as ProviderDetails[];
  render(<ModelContextSettings providers={providers} />);
  await screen.findByText(/capacity unconfirmed/);
  const input = screen.getByLabelText('Context capacity tokens');
  fireEvent.change(input, { target: { value: '131072' } });
  fireEvent.click(screen.getByText('Save capacity'));
  await waitFor(() =>
    expect(acpSaveProviderConfig).toHaveBeenCalledWith(
      'p',
      [{ key: 'contextWindow:one', value: '131072' }],
      []
    )
  );
  await screen.findByText(/Saved for the next prompt/);
  fireEvent.change(input, { target: { value: '' } });
  fireEvent.click(screen.getByText('Save capacity'));
  await waitFor(() =>
    expect(acpSaveProviderConfig).toHaveBeenLastCalledWith('p', [], ['contextWindow:one'])
  );
});
