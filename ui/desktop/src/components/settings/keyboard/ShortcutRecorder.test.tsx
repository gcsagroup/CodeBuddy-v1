import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import { defaultKeyboardShortcuts } from '../../../utils/settings';
import KeyboardShortcutsSection from './KeyboardShortcutsSection';
import { ShortcutRecorder } from './ShortcutRecorder';

vi.mock('../../../utils/analytics', () => ({ trackSettingToggled: vi.fn() }));
const originalElectron = window.electron;
afterEach(() => {
  window.electron = originalElectron;
});

describe('ShortcutRecorder platform modifiers', () => {
  it.each([
    ['darwin', { key: 'k', code: 'KeyK', ctrlKey: true }, 'Control+K', 'Ctrl+K'],
    ['darwin', { key: 'k', code: 'KeyK', metaKey: true }, 'CommandOrControl+K', '⌘+K'],
    [
      'darwin',
      { key: 'k', code: 'KeyK', ctrlKey: true, metaKey: true },
      'Control+CommandOrControl+K',
      'Ctrl+⌘+K',
    ],
    [
      'darwin',
      { key: '†', code: 'KeyT', ctrlKey: true, altKey: true },
      'Control+Alt+T',
      'Ctrl+⌥+T',
    ],
    [
      'darwin',
      { key: '÷', code: 'Slash', metaKey: true, altKey: true },
      'CommandOrControl+Alt+/',
      '⌘+⌥+/',
    ],
    ['win32', { key: 'k', code: 'KeyK', ctrlKey: true }, 'CommandOrControl+K', 'Ctrl+K'],
    [
      'win32',
      { key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true },
      'CommandOrControl+Shift+K',
      'Ctrl+Shift+K',
    ],
  ] as const)('records %s %j as %s', async (platform, event, accelerator, label) => {
    window.electron = { ...originalElectron, platform };
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(<ShortcutRecorder value="" onSave={onSave} onCancel={vi.fn()} />, {
      wrapper: IntlTestWrapper,
    });
    fireEvent.keyDown(document.activeElement!, event);
    expect(screen.getByText(label)).toBeVisible();
    expect(onSave).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledExactlyOnceWith(accelerator);
  });

  it('can cancel after recording without saving', async () => {
    window.electron = { ...originalElectron, platform: 'darwin' };
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(<ShortcutRecorder value="" onSave={onSave} onCancel={onCancel} />, {
      wrapper: IntlTestWrapper,
    });
    fireEvent.keyDown(document.activeElement!, { key: 'k', code: 'KeyK', ctrlKey: true });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'saves Mac Control+K with Command held=%s without disabling Command+K',
    async (metaKey) => {
      const shortcuts = { ...defaultKeyboardShortcuts, focusWindow: 'CommandOrControl+K' };
      const setSetting = vi.fn().mockResolvedValue(undefined);
      const showMessageBox = vi.fn().mockResolvedValue({ response: 0 });
      window.electron = {
        ...originalElectron,
        platform: 'darwin',
        getSetting: vi.fn().mockResolvedValue(shortcuts),
        setSetting,
        showMessageBox,
      };
      const user = userEvent.setup();
      render(<KeyboardShortcutsSection />, { wrapper: IntlTestWrapper });
      const heading = await screen.findByRole('heading', { name: 'New Chat' });
      const row = heading.parentElement!.parentElement!;
      await user.click(within(row).getByRole('button', { name: 'Change' }));
      fireEvent.keyDown(document.activeElement!, {
        key: 'k',
        code: 'KeyK',
        ctrlKey: true,
        metaKey,
      });
      expect(screen.queryByText(/This shortcut is already used/)).toBeNull();
      expect(setSetting).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(setSetting).toHaveBeenCalledExactlyOnceWith('keyboardShortcuts', {
          ...shortcuts,
          newChat: metaKey ? 'Control+CommandOrControl+K' : 'Control+K',
        })
      );
      expect(showMessageBox).not.toHaveBeenCalled();
    }
  );
});
