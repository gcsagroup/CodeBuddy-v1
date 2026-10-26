import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import UpdateSection from './UpdateSection';
import type { UpdateState } from '../../../update/types';
vi.mock('../../../i18n', () => ({
  defineMessages: (value: unknown) => value,
  useIntl: () => intl,
}));
const intl = {
  formatMessage: (message: { defaultMessage: string }, values: Record<string, unknown> = {}) =>
    message.defaultMessage.replace(/\{(\w+)\}/g, (_match, key) => String(values[key] ?? '')),
};
const idle: UpdateState = { phase: 'idle', channel: 'preview', currentVersion: '1.43.10' };
let callback: (value: { event: string; data: UpdateState }) => void;
const unsubscribe = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(window.electron, {
    getVersion: () => '1.43.10',
    getUpdateState: vi.fn().mockResolvedValue(idle),
    onUpdaterEvent: vi.fn((fn) => {
      callback = fn;
      return unsubscribe;
    }),
    checkForUpdates: vi
      .fn()
      .mockResolvedValue({ ...idle, phase: 'available', version: '1.43.11', notes: 'Fixes' }),
    downloadUpdate: vi.fn().mockResolvedValue({ ...idle, phase: 'ready', version: '1.43.11' }),
    installUpdate: vi
      .fn()
      .mockResolvedValue({ ...idle, phase: 'ready', version: '1.43.11' }),
    cancelUpdate: vi.fn().mockResolvedValue(undefined),
  });
});
it('checks, downloads only on click and keeps a deferred update ready without an error', async () => {
  const view = render(<UpdateSection />);
  expect(screen.getByRole('combobox')).toHaveValue('preview');
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
  expect(window.electron.checkForUpdates).toHaveBeenCalledWith('preview');
  fireEvent.click(await screen.findByRole('button', { name: 'Download update' }));
  expect(window.electron.downloadUpdate).toHaveBeenCalledOnce();
  fireEvent.click(await screen.findByRole('button', { name: 'Restart and update' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Restarting will stop running tasks'));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Restart and update' })).toBeEnabled();
  view.unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
it('allows selecting stable explicitly and renders a recovered download state', async () => {
  render(<UpdateSection />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'stable' } });
  expect(window.electron.checkForUpdates).toHaveBeenCalledWith('stable');
  await waitFor(() => expect(screen.getByText('Fixes')).toBeInTheDocument());
  const { act } = await import('@testing-library/react');
  act(() => callback({ event: 'state', data: { ...idle, phase: 'downloading', percent: 45 } }));
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', '45');
  expect(screen.getByRole('button', { name: 'Check for updates' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel download' }));
  expect(window.electron.cancelUpdate).toHaveBeenCalledOnce();
});
