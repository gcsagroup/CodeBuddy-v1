import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { acpListProviderModels } from '../../../acp/providers';
import {
  readModelCapabilityOverrides,
  saveModelCapabilityOverrides,
} from '../../../acp/modelCapabilities';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import type { ProviderDetails } from '../../../types/providers';
import ModelImageCapabilitySettings from './ModelImageCapabilitySettings';

vi.mock('../../../acp/providers', () => ({ acpListProviderModels: vi.fn() }));
vi.mock('../../../acp/modelCapabilities', () => ({
  readModelCapabilityOverrides: vi.fn(),
  saveModelCapabilityOverrides: vi.fn(),
}));
const providers = ['one', 'two'].map((name) => ({
  name,
  metadata: { display_name: name },
})) as ProviderDetails[];
const other = {
  providerId: 'other',
  modelId: 'retained',
  imageInput: 'force_unsupported' as const,
};
const renderSettings = () =>
  render(<ModelImageCapabilitySettings providers={providers} />, { wrapper: IntlTestWrapper });
async function selectModel() {
  fireEvent.change(screen.getByLabelText('Model connection'), {
    target: { value: 'one' },
  });
  await screen.findByRole('option', { name: 'model-one' });
  fireEvent.change(screen.getByLabelText('Model'), {
    target: { value: 'model-one' },
  });
}
describe('image capability settings', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(acpListProviderModels).mockResolvedValue([{ id: 'model-one', name: 'model-one' }]);
    vi.mocked(readModelCapabilityOverrides).mockResolvedValue({ version: 1, overrides: [] });
    vi.mocked(saveModelCapabilityOverrides).mockResolvedValue();
  });
  it('does not enable vision by discovery, and preserves unrelated declarations on explicit save', async () => {
    renderSettings();
    await selectModel();
    expect(screen.getByLabelText('Image input capability')).toHaveValue('auto');
    expect(saveModelCapabilityOverrides).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Image input capability'), {
      target: { value: 'force_supported' },
    });
    vi.mocked(readModelCapabilityOverrides).mockResolvedValue({ version: 1, overrides: [other] });
    fireEvent.click(screen.getByRole('button', { name: 'Save capability correction' }));
    await screen.findByRole('status');
    expect(saveModelCapabilityOverrides).toHaveBeenCalledWith({
      version: 1,
      overrides: [
        other,
        { providerId: 'one', modelId: 'model-one', imageInput: 'force_supported' },
      ],
    });
  });
  it('retains the selected declaration after save failure and allows retry', async () => {
    renderSettings();
    await selectModel();
    fireEvent.change(screen.getByLabelText('Image input capability'), {
      target: { value: 'force_unsupported' },
    });
    vi.mocked(saveModelCapabilityOverrides).mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Save capability correction' }));
    await screen.findByRole('alert');
    expect(screen.getByLabelText('Image input capability')).toHaveValue('force_unsupported');
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save capability correction' }));
    await screen.findByRole('status');
    expect(saveModelCapabilityOverrides).toHaveBeenCalledTimes(2);
  });
  it('ignores an earlier provider discovery after the user changes provider', async () => {
    let release!: (value: Array<{ id: string; name: string }>) => void;
    vi.mocked(acpListProviderModels).mockImplementation((provider) =>
      provider === 'one'
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve([{ id: 'model-two', name: 'model-two' }])
    );
    renderSettings();
    fireEvent.change(screen.getByLabelText('Model connection'), {
      target: { value: 'one' },
    });
    fireEvent.change(screen.getByLabelText('Model connection'), {
      target: { value: 'two' },
    });
    await screen.findByRole('option', { name: 'model-two' });
    await act(async () => release([{ id: 'obsolete', name: 'obsolete' }]));
    await waitFor(() => expect(screen.queryByRole('option', { name: 'obsolete' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Save capability correction' })).toBeDisabled();
  });
  it('keeps saving disabled after discovery fails and retries the same provider', async () => {
    vi.mocked(acpListProviderModels).mockRejectedValueOnce(new Error('offline'));
    renderSettings();
    fireEvent.change(screen.getByLabelText('Model connection'), {
      target: { value: 'one' },
    });
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Save capability correction' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading models' }));
    await screen.findByRole('option', { name: 'model-one' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(saveModelCapabilityOverrides).not.toHaveBeenCalled();
  });
});
