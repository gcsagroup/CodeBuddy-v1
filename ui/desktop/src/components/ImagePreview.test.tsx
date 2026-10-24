import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import ImagePreview from './ImagePreview';

describe('image preview', () => {
  it('opens a dialog and returns to the thumbnail after Escape', async () => {
    render(<ImagePreview src="data:image/png;base64,aW1hZ2U=" />, { wrapper: IntlTestWrapper });
    const thumbnail = screen.getByRole('button', { name: 'Click to expand' });
    fireEvent.click(thumbnail);
    const dialog = screen.getByRole('dialog', { name: 'CodeBuddy image' });
    expect(within(dialog).getByRole('img')).toHaveAttribute(
      'src',
      'data:image/png;base64,aW1hZ2U='
    );
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeVisible();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(thumbnail).toBeVisible();
  });

  it('allows another image to load after the prior source failed', () => {
    const { rerender } = render(<ImagePreview src="broken.png" />, { wrapper: IntlTestWrapper });
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByText('Unable to load image')).toBeVisible();
    rerender(<ImagePreview src="another.png" />);
    expect(screen.getByRole('img')).toHaveAttribute('src', 'another.png');
    expect(screen.queryByText('Unable to load image')).not.toBeInTheDocument();
  });
});
