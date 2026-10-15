import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ChatInputStopButton } from './ChatInputStopButton';
import { chatInputActionVisibility, shouldShowWorkingDirectorySwitcher } from './ChatInput';
import {
  acceptSubmittedDraft,
  createSubmittedDraftState,
  rejectSubmittedDraft,
} from './chatInputSubmissionLifecycle';

describe('ChatInput submission lifecycle', () => {
  it('clears on acceptance and restores only when a pre-accept failure cannot overwrite newer input', () => {
    const image = { data: 'image', mimeType: 'image/png' };
    const accepted = createSubmittedDraftState('hello', [image], 4);
    const rejected = createSubmittedDraftState('hello', [image], 4);

    expect(acceptSubmittedDraft(accepted, 4)).toEqual({ shouldClear: true });
    expect(rejectSubmittedDraft(accepted, 4)).toEqual({ shouldRestore: false });
    expect(rejectSubmittedDraft(rejected, 4)).toEqual({
      shouldRestore: true,
      text: 'hello',
      images: [image],
    });
    expect(rejectSubmittedDraft(rejected, 5)).toEqual({ shouldRestore: false });
  });
});

describe('ChatInput stop control', () => {
  it('shows the project chooser only when the current view can change the project directory', () => {
    expect(shouldShowWorkingDirectorySwitcher(false, true)).toBe(true);
    expect(shouldShowWorkingDirectorySwitcher(false, false)).toBe(false);
    expect(shouldShowWorkingDirectorySwitcher(true, true)).toBe(false);
  });

  it('keeps emergency stop visible while a running task has a sendable draft', () => {
    expect(chatInputActionVisibility(true, true)).toEqual({
      showStop: true,
      showSend: true,
    });
    expect(chatInputActionVisibility(true, false)).toEqual({
      showStop: true,
      showSend: false,
    });
    expect(chatInputActionVisibility(false, true)).toEqual({
      showStop: false,
      showSend: true,
    });
  });

  it('has a matching accessible name and tooltip and stops once per keyboard activation', async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    render(<ChatInputStopButton label="Stop" onStop={onStop} />);

    const button = screen.getByRole('button', { name: 'Stop' });
    expect(button).toHaveAttribute('title', 'Stop');

    button.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');

    expect(onStop).toHaveBeenCalledTimes(2);
  });
});
