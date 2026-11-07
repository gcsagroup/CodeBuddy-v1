import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { WindowMenuBar } from './WindowMenuBar';
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));

it('shows only menus, opens native entries and supports keyboard focus without taking composer input', async () => {
  const open = vi.fn().mockResolvedValue(undefined);
  Object.assign(window.electron, {
    platform: 'win32',
    getWindowMenu: vi.fn().mockResolvedValue([
      { index: 0, label: '文件', enabled: true },
      { index: 1, label: '编辑', enabled: true },
      { index: 2, label: 'Unavailable', enabled: false },
    ]),
    openWindowMenu: open,
    setTitlebarTheme: vi.fn().mockResolvedValue(undefined),
  });
  render(
    <>
      <input aria-label="Message" />
      <WindowMenuBar />
    </>
  );
  const file = await screen.findByRole('menuitem', { name: '文件' });
  expect(screen.queryByText('CodeBuddy')).toBeNull();
  const input = screen.getByLabelText('Message');
  input.focus();
  fireEvent.keyDown(window, { key: 'F10' });
  expect(file).toHaveFocus();
  fireEvent.keyDown(file, { key: 'End' });
  expect(screen.getByRole('menuitem', { name: '编辑' })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole('menuitem', { name: '编辑' }), { key: 'Home' });
  expect(file).toHaveFocus();
  fireEvent.keyDown(file, { key: 'ArrowRight' });
  expect(screen.getByRole('menuitem', { name: '编辑' })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole('menuitem', { name: '编辑' }), { key: 'ArrowDown' });
  await waitFor(() => expect(open).toHaveBeenCalledWith(1, 0, 0));
  fireEvent.keyDown(file, { key: 'Escape' });
  expect(input).toHaveFocus();
  fireEvent.mouseDown(file);
  fireEvent.click(file);
  await waitFor(() => expect(open).toHaveBeenCalledWith(0, 0, 0));
  expect(input).toHaveFocus();
});
