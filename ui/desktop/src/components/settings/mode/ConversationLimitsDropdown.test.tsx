import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationLimitsDropdown } from './ConversationLimitsDropdown';

vi.mock('../../../i18n', () => ({
  defineMessages: (messages: unknown) => messages,
  useIntl: () => ({
    formatMessage: (message: { defaultMessage: string }) => message.defaultMessage,
  }),
}));

describe('ConversationLimitsDropdown', () => {
  const onMaxTurnsChange = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    onMaxTurnsChange.mockResolvedValue(730);
  });

  const renderDropdown = (overrides: { disabled?: boolean; isSaving?: boolean } = {}) =>
    render(
      <ConversationLimitsDropdown
        maxTurns={1000}
        disabled={overrides.disabled ?? false}
        isSaving={overrides.isSaving ?? false}
        onMaxTurnsChange={onMaxTurnsChange}
      />
    );

  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => {
      resolve = next;
    });
    return { promise, resolve };
  };

  it('keeps a local draft and commits a valid integer only on blur', async () => {
    renderDropdown();
    const input = screen.getByRole('spinbutton');

    fireEvent.change(input, { target: { value: '600' } });
    expect(input).toHaveValue(600);
    expect(onMaxTurnsChange).not.toHaveBeenCalled();

    fireEvent.blur(input);
    await waitFor(() => expect(onMaxTurnsChange).toHaveBeenCalledWith(600));
    await waitFor(() => expect(input).toHaveValue(730));
  });

  it.each(['', '0', '10001', '1.5', 'not-a-number'])(
    'does not submit the invalid local draft %j',
    async (draft) => {
      renderDropdown();
      const input = screen.getByRole('spinbutton');

      fireEvent.change(input, { target: { value: draft } });
      fireEvent.blur(input);
      await Promise.resolve();

      expect(onMaxTurnsChange).not.toHaveBeenCalled();
      expect(input).toHaveAttribute('aria-invalid', 'true');
    }
  );

  it('keeps a failed draft and allows the same value to be retried', async () => {
    onMaxTurnsChange.mockResolvedValueOnce(null).mockResolvedValueOnce(650);
    renderDropdown();
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '600' } });

    fireEvent.blur(input);
    await waitFor(() => expect(onMaxTurnsChange).toHaveBeenCalledTimes(1));
    expect(input).toHaveValue(600);

    fireEvent.focus(input);
    fireEvent.blur(input);
    await waitFor(() => expect(onMaxTurnsChange).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(input).toHaveValue(650));
  });

  it('does not overwrite an active draft when a slower preference snapshot arrives', async () => {
    const { rerender } = renderDropdown();
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '600' } });

    rerender(
      <ConversationLimitsDropdown
        maxTurns={900}
        disabled={false}
        isSaving={false}
        onMaxTurnsChange={onMaxTurnsChange}
      />
    );

    expect(input).toHaveValue(600);
    fireEvent.blur(input);
    await waitFor(() => expect(onMaxTurnsChange).toHaveBeenCalledWith(600));
  });

  it('disables editing while loading is unsafe or a save is pending', () => {
    const { rerender } = renderDropdown({ disabled: true });
    expect(screen.getByRole('spinbutton')).toBeDisabled();

    rerender(
      <ConversationLimitsDropdown
        maxTurns={1000}
        disabled={false}
        isSaving={true}
        onMaxTurnsChange={onMaxTurnsChange}
      />
    );
    expect(screen.getByRole('spinbutton')).toBeDisabled();
  });

  it('submits only once when Enter is followed by blur while the save is pending', async () => {
    const pending = deferred<number | null>();
    onMaxTurnsChange.mockReturnValue(pending.promise);
    renderDropdown();
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '600' } });

    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    await waitFor(() => expect(onMaxTurnsChange).toHaveBeenCalledTimes(1));
    expect(input).toBeDisabled();

    pending.resolve(600);
    await waitFor(() => expect(input).toBeEnabled());
    expect(onMaxTurnsChange).toHaveBeenCalledTimes(1);
  });
});
