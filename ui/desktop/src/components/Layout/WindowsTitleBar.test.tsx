import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { WindowsTitleBar } from './WindowsTitleBar';

vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

const getWindowMenu = vi.fn();
const openWindowMenu = vi.fn();
const setWindowTitleBarTheme = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  getWindowMenu.mockResolvedValue([
    { index: 0, label: 'Archivo', enabled: true },
    { index: 4, label: 'Ayuda', enabled: true },
  ]);
  openWindowMenu.mockResolvedValue(undefined);
  Object.assign(window.electron, {
    getWindowMenu,
    openWindowMenu,
    setWindowTitleBarTheme,
  });
});

it('uses the host menu labels and native index, and tracks the native popup lifetime', async () => {
  let closeMenu!: () => void;
  openWindowMenu.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        closeMenu = resolve;
      })
  );
  render(<WindowsTitleBar />);
  const help = await screen.findByRole('menuitem', { name: 'Ayuda' });
  vi.spyOn(help, 'getBoundingClientRect').mockReturnValue({ left: 64, bottom: 40 } as DOMRect);

  await userEvent.click(help);
  expect(openWindowMenu).toHaveBeenCalledWith({ index: 4, x: 64, y: 40 });
  expect(help).toHaveAttribute('aria-expanded', 'true');
  await act(async () => closeMenu());
  expect(help).toHaveAttribute('aria-expanded', 'false');
});

it('supports moving between menus and opening a native menu with the keyboard', async () => {
  render(<WindowsTitleBar />);
  const file = await screen.findByRole('menuitem', { name: 'Archivo' });
  file.focus();
  await userEvent.keyboard('{ArrowRight}');
  expect(screen.getByRole('menuitem', { name: 'Ayuda' })).toHaveFocus();
  await userEvent.keyboard('{ArrowDown}');
  expect(openWindowMenu).toHaveBeenCalledWith(expect.objectContaining({ index: 4 }));
  expect(setWindowTitleBarTheme).toHaveBeenCalledWith('light');
});

it('keeps the input focus when opening a menu with the mouse so editing commands retain their target', async () => {
  render(
    <>
      <textarea aria-label="Draft" />
      <WindowsTitleBar />
    </>
  );
  const file = await screen.findByRole('menuitem', { name: 'Archivo' });
  const draft = screen.getByRole('textbox', { name: 'Draft' });
  draft.focus();
  openWindowMenu.mockImplementation(async () => {
    expect(draft).toHaveFocus();
  });
  await userEvent.click(file);
  expect(openWindowMenu).toHaveBeenCalled();
  expect(draft).toHaveFocus();
});
