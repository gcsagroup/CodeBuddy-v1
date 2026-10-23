import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { acpReadConfig, acpUpsertConfig } from '../../../acp/config';
import SubagentLimitsSettings from './SubagentLimitsSettings';

vi.mock('../../../i18n', () => ({
  defineMessages: <T,>(messages: T) => messages,
  useIntl: () => ({
    formatMessage: (message: { defaultMessage: string }) => message.defaultMessage,
  }),
}));
vi.mock('../../../acp/config', () => ({ acpReadConfig: vi.fn(), acpUpsertConfig: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(acpReadConfig).mockResolvedValue({ maxDepth: 1, maxActiveSubagents: 3 });
});

it('keeps invalid and failed drafts, allows depth zero and saves only explicit limits', async () => {
  const dirty = vi.fn();
  render(<SubagentLimitsSettings onDirtyChange={dirty} />);
  const depth = screen.getByLabelText('Maximum recursion depth');
  const parallel = screen.getByLabelText('Maximum parallel subagents');
  const save = screen.getByRole('button', { name: 'Save limits' });
  await waitFor(() => expect(parallel).toHaveValue(3));
  expect(save).toBeDisabled();
  fireEvent.change(depth, { target: { value: '' } });
  expect(save).toBeDisabled();
  fireEvent.change(depth, { target: { value: '0' } });
  fireEvent.change(parallel, { target: { value: '0' } });
  expect(save).toBeDisabled();
  fireEvent.change(parallel, { target: { value: '1.5' } });
  expect(save).toBeDisabled();
  fireEvent.change(parallel, { target: { value: '4' } });
  expect(dirty).toHaveBeenLastCalledWith(true);
  vi.mocked(acpUpsertConfig).mockRejectedValueOnce(new Error('fixture unavailable'));
  fireEvent.click(save);
  await screen.findByRole('alert');
  expect(depth).toHaveValue(0);
  expect(parallel).toHaveValue(4);
  expect(save).toBeEnabled();
  fireEvent.click(save);
  await screen.findByRole('status');
  expect(acpUpsertConfig).toHaveBeenLastCalledWith('subagentLimits', {
    maxDepth: 0,
    maxActiveSubagents: 4,
  });
  expect(dirty).toHaveBeenLastCalledWith(false);
  expect(save).toBeDisabled();
});

it('does not offer fabricated defaults when reading failed and supports retry', async () => {
  vi.mocked(acpReadConfig).mockRejectedValueOnce(new Error('offline'));
  render(<SubagentLimitsSettings onDirtyChange={vi.fn()} />);
  await screen.findByRole('alert');
  expect(screen.getByLabelText('Maximum recursion depth')).toBeDisabled();
  expect(acpUpsertConfig).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.getByLabelText('Maximum recursion depth')).toHaveValue(1));
});
