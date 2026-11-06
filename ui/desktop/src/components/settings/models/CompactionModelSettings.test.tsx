import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { acpReadConfig, acpUpsertConfig } from '../../../acp/config';
import type { ProviderDetails } from '../../../types/providers';
import CompactionModelSettings from './CompactionModelSettings';

vi.mock('../../../i18n', () => ({ useIntl: () => ({ locale: 'en' }) }));
vi.mock('../../../acp/config', () => ({ acpReadConfig: vi.fn(), acpUpsertConfig: vi.fn() }));
const providers = [
  {
    name: 'lan',
    is_configured: true,
    category: 'model',
    metadata: { display_name: 'LAN', known_models: [{ name: 'summary-26b' }] },
  },
] as ProviderDetails[];
const choice = { providerId: 'lan', modelId: 'summary-26b' };
const value = JSON.stringify(['lan', 'summary-26b']);
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(acpReadConfig).mockResolvedValue(null);
  vi.mocked(acpUpsertConfig).mockResolvedValue();
});

it('defaults to following and saves only the independent compaction choice', async () => {
  const dirty = vi.fn();
  render(<CompactionModelSettings providers={providers} onDirtyChange={dirty} />);
  const select = await screen.findByRole('combobox', { name: 'Compaction model' });
  await waitFor(() => expect(select).toBeEnabled());
  expect(select).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Save compaction model' })).toBeDisabled();
  fireEvent.change(select, { target: { value } });
  expect(dirty).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole('button', { name: 'Save compaction model' }));
  await screen.findByText(/Saved. Applies/);
  expect(acpUpsertConfig).toHaveBeenCalledExactlyOnceWith('compactionModel', choice, false);
  expect(dirty).toHaveBeenLastCalledWith(false);
});

it('retains an unavailable saved choice and explicitly clears it to follow the conversation', async () => {
  vi.mocked(acpReadConfig).mockResolvedValue({ providerId: 'removed', modelId: 'old-model' });
  render(<CompactionModelSettings providers={providers} />);
  await screen.findByText(/The saved model is unavailable/);
  expect(screen.getByRole('button', { name: 'Save compaction model' })).toBeDisabled();
  expect(acpUpsertConfig).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('combobox', { name: 'Compaction model' }), {
    target: { value: '' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save compaction model' }));
  await waitFor(() => expect(acpUpsertConfig).toHaveBeenCalledWith('compactionModel', null, false));
});

it('keeps the draft and previous saved setting after failure and allows retry', async () => {
  render(<CompactionModelSettings providers={providers} />);
  const select = screen.getByRole('combobox', { name: 'Compaction model' });
  await waitFor(() => expect(select).toBeEnabled());
  fireEvent.change(select, { target: { value } });
  vi.mocked(acpUpsertConfig).mockRejectedValueOnce(new Error('Connection was removed'));
  fireEvent.click(screen.getByRole('button', { name: 'Save compaction model' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Connection was removed');
  expect(select).toHaveValue(value);
  fireEvent.click(screen.getByRole('button', { name: 'Save compaction model' }));
  await screen.findByText(/Saved. Applies/);
  expect(acpUpsertConfig).toHaveBeenCalledTimes(2);
});

it('retries a failed settings read without replacing the saved model with a default', async () => {
  vi.mocked(acpReadConfig).mockRejectedValueOnce(new Error('Read unavailable'));
  render(<CompactionModelSettings providers={providers} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Read unavailable');
  expect(screen.getByRole('combobox', { name: 'Compaction model' })).toBeDisabled();
  vi.mocked(acpReadConfig).mockResolvedValue(choice);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry settings' })));
  await waitFor(() =>
    expect(screen.getByRole('combobox', { name: 'Compaction model' })).toHaveValue(value)
  );
  expect(acpUpsertConfig).not.toHaveBeenCalled();
});
