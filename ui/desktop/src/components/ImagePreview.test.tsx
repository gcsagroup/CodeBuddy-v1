import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import ImagePreview from './ImagePreview';
import { WorkspaceMedia } from '../workspace-panel/WorkspaceMedia';

const sizing = { node: undefined as HTMLElement | undefined, resize: () => {} };
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        sizing.resize = callback;
      }
      observe(node: HTMLElement) {
        sizing.node = node;
      }
      disconnect() {}
    }
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('image preview', () => {
  it('opens a dialog and returns to the thumbnail after Escape', async () => {
    render(<ImagePreview src="data:image/png;base64,aW1hZ2U=" />, { wrapper: IntlTestWrapper });
    const thumbnail = screen.getByRole('button', { name: 'Click to expand' });
    expect(screen.queryByText('Click to expand')).toBeNull();
    fireEvent.click(thumbnail);
    const dialog = screen.getByRole('dialog', { name: 'CodeBuddy image' });
    expect(within(dialog).getByRole('img')).toHaveAttribute(
      'src',
      'data:image/png;base64,aW1hZ2U='
    );
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeVisible();
    expect(within(dialog).getAllByRole('button', { name: 'Fit to window' })).toHaveLength(1);
    expect(within(dialog).getByText('100%')).toBeVisible();
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

it('fits after the dialog portal mounts and zooms from the displayed scale', () => {
  render(<ImagePreview src="landscape.png" />, { wrapper: IntlTestWrapper });
  fireEvent.click(screen.getByRole('button', { name: 'Click to expand' }));
  const dialog = screen.getByRole('dialog');
  const image = within(dialog).getByRole('img');
  expect(sizing.node).toBe(image.parentElement);
  Object.defineProperties(sizing.node!, {
    clientWidth: { value: 800 },
    clientHeight: { value: 600, configurable: true },
  });
  Object.defineProperties(image, { naturalWidth: { value: 1600 }, naturalHeight: { value: 1200 } });
  fireEvent.load(image);
  act(() => sizing.resize());
  expect(within(dialog).getByText('50%')).toBeVisible();
  expect(image).toHaveStyle({ width: '800px', height: '600px' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Zoom in' }));
  expect(within(dialog).getByText('75%')).toBeVisible();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Fit to window' }));
  Object.defineProperty(sizing.node!, 'clientHeight', { value: 300 });
  act(() => sizing.resize());
  expect(within(dialog).getByText('25%')).toBeVisible();
  expect(image).toHaveStyle({ width: '400px', height: '300px' });
});

it('enlarges generated image pixels without opening a file tab, preserves image menus and Ctrl click, and resets zoom on reopen', async () => {
  const opened = vi.fn();
  window.addEventListener('codebuddy:open-workspace-file', opened);
  try {
    render(
      <WorkspaceMedia
        media={{ kind: 'image', mimeType: 'image/png', url: 'codebuddy-media://preview/fixture' }}
        title="Generated image"
        target={{ sessionId: 'lightbox', filePath: 'sun.png' }}
      />,
      { wrapper: IntlTestWrapper }
    );
    const image = screen.getByRole('img');
    fireEvent.click(image);
    const dialog = screen.getByRole('dialog', { name: 'Generated image' });
    expect(opened).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Zoom in' }));
    expect(within(dialog).getByText('125%')).toBeVisible();
    fireEvent.contextMenu(within(dialog).getByRole('img'));
    expect(opened.mock.lastCall?.[0].detail).toEqual({
      sessionId: 'lightbox',
      filePath: 'sun.png',
      action: 'file-menu',
      menuKind: 'image',
    });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(image, { ctrlKey: true });
    expect(opened.mock.lastCall?.[0].detail.action).toBe('open-external');
    fireEvent.keyDown(image, { key: 'Enter' });
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.queryByText('125%')).toBeNull();
  } finally {
    window.removeEventListener('codebuddy:open-workspace-file', opened);
  }
});
