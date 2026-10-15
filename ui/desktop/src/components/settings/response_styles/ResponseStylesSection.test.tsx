import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppEvents } from '../../../constants/events';
import { ResponseStylesSection } from './ResponseStylesSection';

vi.mock('../../../i18n', () => ({
  defineMessages: (messages: unknown) => messages,
  useIntl: () => ({
    formatMessage: (message: { defaultMessage: string }) => message.defaultMessage,
  }),
}));

describe('ResponseStylesSection persistence', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    window.electron.getSetting = vi.fn().mockResolvedValue('concise');
    window.electron.setSetting = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('updates the selection and notifies consumers after persistence succeeds', async () => {
    const changed = vi.fn();
    window.addEventListener(AppEvents.RESPONSE_STYLE_CHANGED, changed);
    render(<ResponseStylesSection />);
    const detailed = await screen.findByRole('radio', { name: 'Detailed' });
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Concise' })).toBeChecked());

    fireEvent.click(detailed);

    await waitFor(() =>
      expect(window.electron.setSetting).toHaveBeenCalledWith('responseStyle', 'detailed')
    );
    await waitFor(() => expect(detailed).toBeChecked());
    expect(changed).toHaveBeenCalledOnce();
    window.removeEventListener(AppEvents.RESPONSE_STYLE_CHANGED, changed);
  });

  it('keeps the previous selection and does not notify consumers when saving fails', async () => {
    window.electron.setSetting = vi.fn().mockRejectedValue(new Error('disk unavailable'));
    const changed = vi.fn();
    window.addEventListener(AppEvents.RESPONSE_STYLE_CHANGED, changed);
    render(<ResponseStylesSection />);
    const concise = await screen.findByRole('radio', { name: 'Concise' });
    await waitFor(() => expect(concise).toBeChecked());

    fireEvent.click(screen.getByRole('radio', { name: 'Detailed' }));

    await waitFor(() => expect(window.electron.setSetting).toHaveBeenCalledOnce());
    await waitFor(() => expect(concise).toBeChecked());
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to save. Try again later.');
    window.removeEventListener(AppEvents.RESPONSE_STYLE_CHANGED, changed);
  });
});
