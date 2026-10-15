import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PromptErrorBanner } from './PromptErrorBanner';

describe('PromptErrorBanner', () => {
  it('keeps a prompt failure visible and lets the user dismiss it', () => {
    const onDismiss = vi.fn();

    render(
      <PromptErrorBanner
        message="Submit error: project folder is required"
        dismissLabel="Dismiss error"
        onDismiss={onDismiss}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Submit error: project folder is required');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
