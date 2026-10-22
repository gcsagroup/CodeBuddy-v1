import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
const save = () => screen.getByRole('button', { name: 'Save subagent settings' });
const openExplorer = async () =>
  fireEvent.click(await screen.findByRole('button', { name: 'explorer · Workspace exploration' }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(acpReadConfig).mockResolvedValue(null);
  vi.mocked(acpUpsertConfig).mockResolvedValue();
  vi.mocked(acpListProviderModels).mockResolvedValue([{ id: 'model-one' }] as Awaited<
    ReturnType<typeof acpListProviderModels>
  >);
});

it('lists saved models and saves only the selected default role', async () => {
  render(<SubagentTemplateSettings providers={providers} />);
  await screen.findByRole('button', { name: 'Add subagent' });
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  await openExplorer();
  const model = screen.getByLabelText('Model');
  expect(model).toHaveValue('');
  await waitFor(() =>
    expect(model.querySelector('optgroup option')).toHaveTextContent('model-one')
  );
  fireEvent.change(model, { target: { value: JSON.stringify(['one', 'model-one']) } });
  fireEvent.click(save());
  await screen.findByText('Saved. Applies to new subagents.');
  expect(acpUpsertConfig).toHaveBeenLastCalledWith('subagentTemplates', {
    version: 1,
    models: { explorer: { providerId: 'one', modelId: 'model-one' }, browser: null, generic: null },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Other chat-local responsibilities' }));
  fireEvent.change(screen.getByLabelText('Model'), {
    target: { value: JSON.stringify(['two', '']) },
  });
  expect(save()).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'custom-model' } });
  fireEvent.click(save());
  await screen.findByText('Saved. Applies to new subagents.');
  expect(acpUpsertConfig).toHaveBeenLastCalledWith('subagentTemplates', {
    version: 1,
    models: {
      explorer: { providerId: 'one', modelId: 'model-one' },
      browser: null,
      generic: { providerId: 'two', modelId: 'custom-model' },
    },
  });
});

it('blocks editing after failed loading and preserves the draft after failed saving', async () => {
  vi.mocked(acpReadConfig).mockRejectedValueOnce(new Error('offline'));
  render(<SubagentTemplateSettings providers={providers} />);
  await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: 'Add subagent' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save subagent settings' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('Retry'));
  await openExplorer();
  fireEvent.change(screen.getByLabelText('Model'), {
    target: { value: JSON.stringify(['one', '']) },
  });
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'kept-model' } });
  vi.mocked(acpUpsertConfig).mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(save());
  await screen.findByRole('alert');
  expect(screen.getByLabelText('Model')).toHaveValue('kept-model');
  expect(screen.queryByText('Saved. Applies to new subagents.')).not.toBeInTheDocument();
});

it('a late model inventory response cannot replace a newer provider list or saved model', async () => {
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
  vi.mocked(acpReadConfig).mockResolvedValue({
    version: 1,
    models: { explorer: { providerId: 'two', modelId: 'second-model' } },
  });
  const view = render(<SubagentTemplateSettings providers={providers} />);
  await openExplorer();
  view.rerender(<SubagentTemplateSettings providers={[providers[1]]} />);
  await waitFor(() =>
    expect(screen.getByLabelText('Model').querySelector('optgroup option')).toHaveTextContent(
      'second-model'
    )
  );
  await act(async () =>
    finishFirst([{ id: 'stale-model' }] as Awaited<ReturnType<typeof acpListProviderModels>>)
  );
  expect(screen.getByLabelText('Model')).toHaveValue(JSON.stringify(['two', 'second-model']));
  expect(screen.queryByText(/stale-model/)).not.toBeInTheDocument();
  expect(acpUpsertConfig).not.toHaveBeenCalled();
});

it('keeps saved models on discovery failure and cancel restores the saved selection', async () => {
  vi.mocked(acpReadConfig).mockResolvedValue({
    version: 1,
    models: { explorer: { providerId: 'one', modelId: 'saved-model' } },
  });
  vi.mocked(acpListProviderModels).mockRejectedValue(new Error('offline'));
  render(<SubagentTemplateSettings providers={providers} />);
  await openExplorer();
  await screen.findByText(/Could not load the model list/);
  expect(screen.getByLabelText('Model')).toHaveValue(JSON.stringify(['one', 'saved-model']));
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await openExplorer();
  expect(screen.getByLabelText('Model')).toHaveValue(JSON.stringify(['one', 'saved-model']));
  expect(acpUpsertConfig).not.toHaveBeenCalled();
  expect(acpListProviderModels).toHaveBeenCalledTimes(2);
});

it('creates a custom subagent using only three fields, saves below the prompt and reopens it', async () => {
  render(<SubagentTemplateSettings providers={providers} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add subagent' }));
  expect(save()).toBeDisabled();
  expect(screen.getByLabelText('Model')).toHaveValue('');
  const editor = screen.getByLabelText('Name').closest('fieldset')!;
  expect(within(editor).getAllByRole('textbox')).toHaveLength(2);
  expect(within(editor).getAllByRole('combobox')).toHaveLength(1);
  expect(
    screen.getByLabelText('Prompt').compareDocumentPosition(save()) &
      Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Reviewer' } });
  fireEvent.change(screen.getByLabelText('Prompt'), {
    target: { value: 'Explain concrete defects. Do not invent findings.' },
  });
  fireEvent.click(save());
  await screen.findByText('Saved. Applies to new subagents.');
  expect(acpUpsertConfig).toHaveBeenLastCalledWith(
    'subagentTemplates',
    expect.objectContaining({
      custom: [
        expect.objectContaining({
          name: 'Reviewer',
          prompt: 'Explain concrete defects. Do not invent findings.',
          description: 'Explain concrete defects. Do not invent findings.',
          model: null,
          tools: null,
        }),
      ],
    })
  );
  fireEvent.click(screen.getByRole('button', { name: 'Reviewer' }));
  expect(screen.getByLabelText('Prompt')).toHaveValue(
    'Explain concrete defects. Do not invent findings.'
  );
  expect(save()).toBeDisabled();
});

it('does not let an unfinished new agent block other edits, and reports unsaved state', async () => {
  const onDirtyChange = vi.fn();
  render(<SubagentTemplateSettings providers={providers} onDirtyChange={onDirtyChange} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add subagent' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Unfinished' } });
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  expect(screen.queryByRole('button', { name: 'Unfinished' })).not.toBeInTheDocument();
  await openExplorer();
  expect(screen.getByLabelText('Model')).toHaveValue('');
  expect(acpUpsertConfig).not.toHaveBeenCalled();
});

it('keeps other templates and hidden restrictions unchanged; failed deletion preserves the template', async () => {
  const custom = ['Reviewer', 'Writer'].map((name) => ({
    id: name,
    name,
    description: 'When needed',
    prompt: 'Keep this responsibility',
    model: null,
    tools: name === 'Reviewer' ? 'read-only' : 'none',
  }));
  vi.mocked(acpReadConfig).mockResolvedValue({ version: 1, models: {}, custom });
  render(<SubagentTemplateSettings providers={providers} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Reviewer' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'writer' } });
  expect(save()).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Updated reviewer' } });
  vi.mocked(acpUpsertConfig).mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(save());
  await screen.findByRole('alert');
  expect(screen.getByLabelText('Name')).toHaveValue('Updated reviewer');
  fireEvent.click(save());
  await screen.findByText('Saved. Applies to new subagents.');
  expect(acpUpsertConfig).toHaveBeenLastCalledWith(
    'subagentTemplates',
    expect.objectContaining({ custom: [{ ...custom[0], name: 'Updated reviewer' }, custom[1]] })
  );
  fireEvent.click(screen.getByRole('button', { name: 'Updated reviewer' }));
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.mocked(acpUpsertConfig).mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Remove template' }));
  await screen.findByRole('alert');
  expect(screen.getByLabelText('Name')).toHaveValue('Updated reviewer');
  fireEvent.click(screen.getByRole('button', { name: 'Remove template' }));
  await screen.findByText('Saved. Applies to new subagents.');
  expect(acpUpsertConfig).toHaveBeenLastCalledWith(
    'subagentTemplates',
    expect.objectContaining({ custom: [custom[1]] })
  );
  expect(screen.queryByRole('button', { name: 'Updated reviewer' })).not.toBeInTheDocument();
  confirm.mockRestore();
});

it('does not overwrite unreadable custom settings', async () => {
  vi.mocked(acpReadConfig).mockResolvedValue({
    version: 1,
    models: {},
    custom: [{ id: 'broken', prompt: 123 }],
  });
  render(<SubagentTemplateSettings providers={providers} />);
  await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: 'Add subagent' })).not.toBeInTheDocument();
  expect(acpUpsertConfig).not.toHaveBeenCalled();
});
