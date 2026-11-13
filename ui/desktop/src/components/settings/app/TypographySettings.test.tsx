import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import { expect, it, vi } from 'vitest';
import { TypographyProvider } from '../../../contexts/TypographyContext';
import { defaultTypography, readTypography, type Typography } from '../../../utils/typography';
import { TypographySettings } from './TypographySettings';

it('loads saved sizes, applies changes from the host, resets and respects the limit', async () => {
  let saved: Typography = { ...defaultTypography, windowZoom: 290, codeFontSize: 47, textSize: 23 };
  let changed: (event: unknown, value: Typography) => void;
  const setSetting = vi.fn(async (key: keyof Typography, value: Typography[keyof Typography]) => {
    saved = { ...saved, [key]: value };
    changed(null, saved);
  });
  const original = window.electron;
  Object.assign(window, {
    electron: {
      getSetting: async (key: keyof Typography) => saved[key],
      setSetting,
      on: (_channel: string, listener: typeof changed) => {
        changed = listener;
      },
    },
  });
  try {
    render(
      <IntlProvider locale="en">
        <TypographyProvider>
          <TypographySettings />
        </TypographyProvider>
      </IntlProvider>
    );
    await screen.findByText('290%');
    const increase = screen.getByRole('button', { name: 'Increase Window zoom' });
    fireEvent.click(increase);
    await screen.findByText('300%');
    expect(increase).toBeDisabled();
    const increaseText = screen.getByRole('button', { name: 'Increase Interface text size' });
    fireEvent.click(increaseText);
    await screen.findByText('24 px');
    expect(increaseText).toBeDisabled();
    expect(document.documentElement.style.fontSize).toMatch(/^27\.42/);
    expect(document.body.style.getPropertyValue('--code-font-size')).toBe('47px');
    const increaseSize = screen.getByRole('button', { name: 'Increase Code font size' });
    fireEvent.click(increaseSize);
    await screen.findByText('48 px');
    expect(increaseSize).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Reset Window zoom' }));
    await screen.findByText('100%');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'serif' } });
    await waitFor(() => expect(document.body.dataset.uiFont).toBe('serif'));
    act(() => changed(null, { ...saved, codeFontSize: 20 }));
    expect(document.body.style.getPropertyValue('--code-font-size')).toBe('20px');
    expect(setSetting).toHaveBeenCalledTimes(5);
  } finally {
    window.electron = original;
  }
});

it('restores safe defaults for invalid saved values and preserves valid fields', () => {
  expect(readTypography({ windowZoom: 0, uiFont: 'bad', codeFontSize: 20 })).toEqual({
    ...defaultTypography,
    codeFontSize: 20,
  });
});
