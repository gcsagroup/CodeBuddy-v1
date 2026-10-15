import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SpellcheckToggle } from './SpellcheckToggle';

vi.mock('../../../i18n', () => ({
  defineMessages: (messages: unknown) => messages,
  useIntl: () => ({
    formatMessage: (message: { defaultMessage: string }) => message.defaultMessage,
  }),
}));

describe('SpellcheckToggle persistence', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    window.electron.getSpellcheckState = vi.fn().mockResolvedValue(true);
    window.electron.setSpellcheck = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('commits the selection only after persistence succeeds', async () => {
    render(<SpellcheckToggle />);
    const toggle = await screen.findByRole('switch', { name: 'Enable Spellcheck' });
    await waitFor(() => expect(toggle).toBeChecked());

    fireEvent.click(toggle);

    await waitFor(() => expect(window.electron.setSpellcheck).toHaveBeenCalledWith(false));
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the previous selection and reports a persistence failure', async () => {
    window.electron.setSpellcheck = vi.fn().mockRejectedValue(new Error('disk unavailable'));
    render(<SpellcheckToggle />);
    const toggle = await screen.findByRole('switch', { name: 'Enable Spellcheck' });
    await waitFor(() => expect(toggle).toBeChecked());

    fireEvent.click(toggle);

    await waitFor(() => expect(window.electron.setSpellcheck).toHaveBeenCalledWith(false));
    await waitFor(() => expect(toggle).toBeChecked());
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to save. Try again later.');
  });
});
