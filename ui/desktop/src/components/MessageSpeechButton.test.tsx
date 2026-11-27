import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { speechPlayback } from '../utils/speechPlayback';
import { speechText } from '../utils/speechText';
import MessageCopyLink from './MessageCopyLink';
import { ModelInventoryNotice } from './ModelInventoryNotice';
afterEach(() => {
  speechPlayback.stop();
  vi.unstubAllGlobals();
});

it('shows cancellable loading spinner while queued and waiting for audio', async () => {
  let resume!: () => void;
  vi.stubGlobal(
    'AudioContext',
    class {
      resume() {
        return new Promise<void>((resolve) => {
          resume = resolve;
        });
      }
      close() {
        resume();
        return Promise.resolve();
      }
    }
  );
  render(<MessageCopyLink text="hello" speakable />, { wrapper: IntlTestWrapper });
  fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }));
  const waiting = screen.getByRole('button', { name: 'Cancel queued playback' });
  expect(waiting).toHaveAttribute('aria-busy', 'true');
  expect(waiting.querySelector('.animate-spin')).not.toBeNull();
  await act(async () => {
    fireEvent.click(waiting);
  });
  expect(screen.getByRole('button', { name: 'Read aloud' })).toBeVisible();
});

it('shows playback failure only in the existing top-right notification center', async () => {
  vi.stubGlobal(
    'AudioContext',
    class {
      constructor() {
        throw new Error('Audio unavailable');
      }
    }
  );
  render(
    <>
      <div data-testid="actions">
        <MessageCopyLink text="hello" speakable />
      </div>
      <ModelInventoryNotice notices={[]} refresh={async () => {}} />
    </>,
    { wrapper: IntlTestWrapper }
  );
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }));
  });
  expect(screen.getByRole('alert')).toHaveTextContent('Audio unavailable');
  expect(screen.getByRole('alert').closest('.model-connection-center')).not.toBeNull();
  expect(screen.getByTestId('actions')).not.toHaveTextContent('Audio unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss playback error' }));
  expect(screen.queryByRole('alert')).toBeNull();
});

it('skips emoji sequences and formatting decorations while retaining words, times and punctuation', () => {
  expect(
    speechText(
      '🌞 **早上好** 👩🏽‍💻！现在是 **17:08**，温度 23.5℃。🇨🇳 1️⃣\n\n---\n\n[帮助](https://example.test)'
    )
  ).toBe('早上好 ！现在是 17:08，温度 23.5℃。 \n\n帮助');
  expect(speechText('🌞 👩🏽‍💻 🇨🇳 1️⃣')).toBe('');
});
