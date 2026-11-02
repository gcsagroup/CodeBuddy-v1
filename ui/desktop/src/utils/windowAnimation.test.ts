import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { maintainVisibleWindowFrames } from './windowAnimation';

describe('visible window frame scheduling', () => {
  it('keeps a visible unfocused window animating, and throttles only while hidden or minimized', () => {
    let visible = false;
    let minimized = false;
    const window = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      isVisible: () => visible,
      isMinimized: () => minimized,
      webContents: { setBackgroundThrottling: vi.fn() },
    });
    maintainVisibleWindowFrames(window as unknown as BrowserWindow);
    const throttle = window.webContents.setBackgroundThrottling;
    expect(throttle).toHaveBeenLastCalledWith(true);
    for (let round = 0; round < 3; round++) {
      visible = true;
      window.emit('show');
      expect(throttle).toHaveBeenLastCalledWith(false);
      window.emit('blur');
      expect(throttle).toHaveBeenLastCalledWith(false);
      minimized = true;
      window.emit('minimize');
      expect(throttle).toHaveBeenLastCalledWith(true);
      minimized = false;
      window.emit('restore');
      expect(throttle).toHaveBeenLastCalledWith(false);
      visible = false;
      window.emit('hide');
      expect(throttle).toHaveBeenLastCalledWith(true);
    }
  });
});
