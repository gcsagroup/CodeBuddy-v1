import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import SubagentTemplateSettings from './SubagentTemplateSettings';
import { acpReadConfig, acpUpsertConfig } from '../../../acp/config';
import { acpListProviderModels } from '../../../acp/providers';
import type { ProviderDetails } from '../../../types/providers';

vi.mock('../../../i18n', () => ({
  defineMessages: <T,>(messages: T) => messages,
  useIntl: () => ({
    formatMessage: (message: { defaultMessage: string }) => message.defaultMessage,
  }),
}));
vi.mock('../../../acp/config', () => ({ acpReadConfig: vi.fn(), acpUpsertConfig: vi.fn() }));
vi.mock('../../../acp/providers', () => ({ acpListProviderModels: vi.fn() }));
const providers = [
  { name: 'one', metadata: { display_name: 'Connection one' } },
  { name: 'two', metadata: { display_name: 'Connection two' } },
] as ProviderDetails[];
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(acpReadConfig).mockResolvedValue(null);
  vi.mocked(acpUpsertConfig).mockResolvedValue();
  vi.mocked(acpListProviderModels).mockResolvedValue([{ id: 'model-one' }] as Awaited<
    ReturnType<typeof acpListProviderModels>
  >);
});

it('defaults to inheritance and saves independent template and generic model choices through existing config ACP', async () => {
  render(<SubagentTemplateSettings providers={providers} />);
  const explorer = await screen.findByLabelText(
    'explorer · Workspace exploration Model connection'
  );
  expect(explorer).toHaveValue('');
  fireEvent.change(explorer, { target: { value: 'one' } });
  const save = screen.getByText('Save subagent models');
  expect(save).toBeDisabled();
  fireEvent.change(screen.getByLabelText('explorer · Workspace exploration Model'), {
    target: { value: 'model-one' },
  });
  fireEvent.change(screen.getByLabelText('Other chat-local responsibilities Model connection'), {
    target: { value: 'two' },
  });
  fireEvent.change(screen.getByLabelText('Other chat-local responsibilities Model'), {
    target: { value: 'custom-model' },
  });
  fireEvent.click(save);
  await screen.findByText('Saved. Applies to new subagents.');
  expect(acpUpsertConfig).toHaveBeenLastCalledWith('subagentTemplates', {
    version: 1,
    models: {
      explorer: { providerId: 'one', modelId: 'model-one' },
      browser: null,
      generic: { providerId: 'two', modelId: 'custom-model' },
    },
  });
  fireEvent.change(explorer, { target: { value: '' } });
  fireEvent.click(save);
  await waitFor(() =>
    expect(acpUpsertConfig).toHaveBeenLastCalledWith(
      'subagentTemplates',
      expect.objectContaining({ models: expect.objectContaining({ explorer: null }) })
    )
  );
});

it('failed loading cannot overwrite saved settings; failed save keeps the user selection', async () => {
  vi.mocked(acpReadConfig).mockRejectedValueOnce(new Error('offline'));
  render(<SubagentTemplateSettings providers={providers} />);
  await screen.findByRole('alert');
  expect(screen.getByText('Save subagent models')).toBeDisabled();
  fireEvent.click(screen.getByText('Retry'));
  const explorer = await screen.findByLabelText(
    'explorer · Workspace exploration Model connection'
  );
  fireEvent.change(explorer, { target: { value: 'one' } });
  fireEvent.change(screen.getByLabelText('explorer · Workspace exploration Model'), {
    target: { value: 'kept-model' },
  });
  vi.mocked(acpUpsertConfig).mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByText('Save subagent models'));
  await screen.findByRole('alert');
  expect(screen.getByLabelText('explorer · Workspace exploration Model')).toHaveValue('kept-model');
  expect(screen.queryByText('Saved. Applies to new subagents.')).not.toBeInTheDocument();
});

it('a late model inventory response cannot replace the currently selected connection', async () => {
  let finishFirst!: (value: Awaited<ReturnType<typeof acpListProviderModels>>) => void;
  vi.mocked(acpListProviderModels).mockImplementation((id) =>
    id === 'one'
      ? new Promise((resolve) => {
          finishFirst = resolve;
        })
      : Promise.resolve([{ id: 'second-model' }] as Awaited<
          ReturnType<typeof acpListProviderModels>
        >)
  );
  render(<SubagentTemplateSettings providers={providers} />);
  const explorer = await screen.findByLabelText(
    'explorer · Workspace exploration Model connection'
  );
  fireEvent.change(explorer, { target: { value: 'one' } });
  fireEvent.change(explorer, { target: { value: 'two' } });
  await waitFor(() =>
    expect(document.querySelector('datalist option[value="second-model"]')).not.toBeNull()
  );
  await act(async () =>
    finishFirst([{ id: 'stale-model' }] as Awaited<ReturnType<typeof acpListProviderModels>>)
  );
  expect(explorer).toHaveValue('two');
  expect(document.querySelector('datalist option[value="stale-model"]')).toBeNull();
});
