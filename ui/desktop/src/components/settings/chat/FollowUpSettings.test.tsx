import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import { FollowUpSettings } from './FollowUpSettings';

afterEach(() => vi.restoreAllMocks());

it('saves the selected policy and reflects the main-process broadcast', async () => {
  let changed!: Parameters<typeof window.electron.on>[1];
  vi.spyOn(window.electron, 'on').mockImplementation((_channel, listener) => { changed = listener; return () => {}; });
  vi.spyOn(window.electron, 'getSetting').mockResolvedValue('steer');
  const save = vi.spyOn(window.electron, 'setSetting').mockImplementation(async (_key, value) => {
    changed({} as Parameters<typeof changed>[0], value);
  });
  render(<FollowUpSettings />, { wrapper: IntlTestWrapper });
  const queue = screen.getByRole('button', { name: 'Queue' });
  await waitFor(() => expect(queue).toBeEnabled());
  fireEvent.click(queue);
  await waitFor(() => expect(queue).toHaveAttribute('aria-pressed', 'true'));
  expect(save).toHaveBeenCalledWith('followUpMode', 'queue');
  act(() => changed({} as Parameters<typeof changed>[0], 'steer'));
  expect(screen.getByRole('button', { name: 'Steer' })).toHaveAttribute('aria-pressed', 'true');
});

it('does not display a new policy as saved when persistence fails', async () => {
  vi.spyOn(window.electron, 'getSetting').mockResolvedValue('steer');
  vi.spyOn(window.electron, 'setSetting').mockRejectedValue(new Error('Storage unavailable'));
  render(<FollowUpSettings />, { wrapper: IntlTestWrapper });
  const queue = screen.getByRole('button', { name: 'Queue' });
  await waitFor(() => expect(queue).toBeEnabled());
  fireEvent.click(queue);
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not save');
  expect(screen.getByRole('button', { name: 'Steer' })).toHaveAttribute('aria-pressed', 'true');
});
