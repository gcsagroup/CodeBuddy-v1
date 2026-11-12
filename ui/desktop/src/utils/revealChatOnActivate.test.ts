import type { BrowserWindow } from 'electron';
import { expect, it, vi } from 'vitest';
import { revealChatOnActivate } from './revealChatOnActivate';

function chat(visible: boolean, minimized = false, focused = false) {
  return {
    isVisible: () => visible, isMinimized: () => minimized, isFocused: () => focused,
    restore: vi.fn(), show: vi.fn(), focus: vi.fn(),
  };
}
const activate = (...windows: ReturnType<typeof chat>[]) =>
  revealChatOnActivate(windows as unknown as BrowserWindow[]);

it('restores a minimized chat before showing and focusing it', () => {
  const win = chat(false, true);
  activate(win);
  expect(win.restore).toHaveBeenCalledBefore(win.show);
  expect(win.show).toHaveBeenCalledBefore(win.focus);
});
it('shows a hidden chat without changing its size', () => {
  const win = chat(false);
  activate(win);
  expect(win.restore).not.toHaveBeenCalled();
  expect(win.show).toHaveBeenCalledBefore(win.focus);
});
it('preserves the focused chat among multiple windows', () => {
  const first = chat(true), current = chat(true, false, true);
  activate(first, current);
  expect(current.focus).toHaveBeenCalledOnce();
  expect(first.show).not.toHaveBeenCalled();
});
it('prefers a visible chat when an auxiliary window has focus', () => {
  const minimized = chat(false, true), visible = chat(true);
  activate(minimized, visible);
  expect(visible.focus).toHaveBeenCalledOnce();
  expect(minimized.restore).not.toHaveBeenCalled();
});
