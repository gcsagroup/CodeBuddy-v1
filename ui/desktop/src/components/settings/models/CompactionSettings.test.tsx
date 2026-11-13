import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import CompactionSettings from './CompactionSettings';
import { acpReadConfig, acpUpsertConfig } from '../../../acp/config';
import type { ProviderDetails } from '../../../types/providers';

vi.mock('../../../i18n', () => ({
  defineMessages: <T,>(messages: T) => messages,
  useIntl: () => ({
    formatMessage: (message: { defaultMessage: string }) => message.defaultMessage,
  }),
}));
vi.mock('../../../acp/config', () => ({ acpReadConfig: vi.fn(), acpUpsertConfig: vi.fn() }));
const providers = [
  {
    name: 'one',
    is_configured: true,
    metadata: { display_name: 'Connection one', known_models: [{ name: 'backup-one' }] },
  },
  {
    name: 'unconfigured',
    is_configured: false,
    metadata: { display_name: 'Incomplete', known_models: [{ name: 'hidden' }] },
  },
] as ProviderDetails[];
const save = () => screen.getByRole('button', { name: 'Save compaction settings' });
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(acpReadConfig).mockResolvedValue(null);
  vi.mocked(acpUpsertConfig).mockResolvedValue();
});

it('saves a configured optional model and explicitly skips it when cleared', async () => {
  const dirty = vi.fn();
  render(<CompactionSettings providers={providers} onDirtyChange={dirty} />);
  await waitFor(() => expect(save()).toBeEnabled());
  const select = screen.getByRole('combobox', { name: 'Optional backup model' });
  expect(select).toHaveValue('');
  expect(select).not.toHaveTextContent('Incomplete');
  fireEvent.change(select, { target: { value: JSON.stringify(['one', 'backup-one']) } });
  await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(true));
  fireEvent.click(save());
  await screen.findByText('Saved. Applies to the next compaction.');
  expect(acpUpsertConfig).toHaveBeenLastCalledWith('compactionFallbackModel', {
    model: { providerId: 'one', modelId: 'backup-one' },
  });
  fireEvent.change(select, { target: { value: '' } });
  fireEvent.click(save());
  await waitFor(() =>
    expect(acpUpsertConfig).toHaveBeenLastCalledWith('compactionFallbackModel', { model: null })
  );
});

it('blocks saving after a read failure and permits a clean retry without overwriting saved data', async () => {
  vi.mocked(acpReadConfig).mockRejectedValue(Error('offline'));
  render(<CompactionSettings providers={providers} />);
  await screen.findByRole('alert');
  expect(save()).toBeDisabled();
  expect(acpUpsertConfig).not.toHaveBeenCalled();
  vi.mocked(acpReadConfig).mockImplementation(async (key) =>
    key === 'compactionFallbackModel'
      ? { model: { providerId: 'one', modelId: 'backup-one' } }
      : null
  );
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() =>
    expect(screen.getByRole('combobox')).toHaveValue(JSON.stringify(['one', 'backup-one']))
  );
});

it('retains a failed save and a missing saved model instead of silently selecting another model', async () => {
  vi.mocked(acpReadConfig).mockImplementation(async (key) =>
    key === 'compactionFallbackModel'
      ? { model: { providerId: 'removed', modelId: 'old-model' } }
      : null
  );
  render(<CompactionSettings providers={providers} />);
  await waitFor(() =>
    expect(screen.getByRole('combobox')).toHaveValue(JSON.stringify(['removed', 'old-model']))
  );
  expect(save()).toBeDisabled();
  fireEvent.change(screen.getByRole('combobox'), {
    target: { value: JSON.stringify(['one', 'backup-one']) },
  });
  vi.mocked(acpUpsertConfig).mockRejectedValue(Error('offline'));
  fireEvent.click(save());
  await screen.findByText('Could not save. Your selection is kept; try again.');
  expect(screen.getByRole('combobox')).toHaveValue(JSON.stringify(['one', 'backup-one']));
});

it('keeps model-specific legacy settings until an explicit save and preserves a draft across provider updates', async () => {
  vi.mocked(acpReadConfig).mockImplementation(async (key) =>
    key === 'compactionFallbacks' ? [] : null
  );
  const view = render(<CompactionSettings providers={providers} />);
  await screen.findByText(
    'Your existing model-specific backups are kept until you save a choice here.'
  );
  fireEvent.change(screen.getByRole('combobox'), {
    target: { value: JSON.stringify(['one', 'backup-one']) },
  });
  await act(async () => view.rerender(<CompactionSettings providers={[...providers]} />));
  expect(screen.getByRole('combobox')).toHaveValue(JSON.stringify(['one', 'backup-one']));
  expect(acpUpsertConfig).not.toHaveBeenCalled();
});
