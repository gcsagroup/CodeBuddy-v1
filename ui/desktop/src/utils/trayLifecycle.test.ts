import { EventEmitter } from 'node:events';
import type { App, BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { registerTrayLifecycle } from './trayLifecycle';

function fixture(platform = 'win32') {
  const app = Object.assign(new EventEmitter(), { quit: vi.fn() });
  let tray = true;
  const attach = registerTrayLifecycle(app as unknown as App, () => tray, platform);
  const window = Object.assign(new EventEmitter(), { hide: vi.fn() });
  attach(window as unknown as BrowserWindow);
  const close = () => {
    const event = { preventDefault: vi.fn() };
    window.emit('close', event);
    return event;
  };
  return { app, window, attach, close, setTray: (value: boolean) => { tray = value; } };
}

describe('Windows close to tray', () => {
  it('keeps the chat window alive across repeated closes without quitting', () => {
    const f = fixture();
    expect(f.close().preventDefault).toHaveBeenCalledOnce();
    expect(f.close().preventDefault).toHaveBeenCalledOnce();
    expect(f.window.hide).toHaveBeenCalledTimes(2);
    f.app.emit('window-all-closed');
    expect(f.app.quit).not.toHaveBeenCalled();
  });

  it('allows explicit quit, including a deferred backend shutdown and second quit', () => {
    const f = fixture();
    f.close();
    f.window.hide.mockClear();
    f.app.emit('before-quit');
    expect(f.close().preventDefault).not.toHaveBeenCalled();
    f.app.emit('before-quit');
    expect(f.close().preventDefault).not.toHaveBeenCalled();
    expect(f.window.hide).not.toHaveBeenCalled();
  });

  it('uses current tray availability and never hides without a working tray', () => {
    const f = fixture();
    f.setTray(false);
    expect(f.close().preventDefault).not.toHaveBeenCalled();
    f.app.emit('window-all-closed');
    expect(f.app.quit).toHaveBeenCalledOnce();
    f.setTray(true);
    expect(f.close().preventDefault).toHaveBeenCalledOnce();
  });

  it.each(['query-session-end', 'session-end'])('does not block Windows %s', (event) => {
    const f = fixture();
    f.window.emit(event);
    expect(f.close().preventDefault).not.toHaveBeenCalled();
    expect(f.window.hide).not.toHaveBeenCalled();
  });

  it('handles multiple main windows independently', () => {
    const f = fixture();
    const other = Object.assign(new EventEmitter(), { hide: vi.fn() });
    f.attach(other as unknown as BrowserWindow);
    f.close();
    expect(other.hide).not.toHaveBeenCalled();
    f.app.emit('before-quit');
    const event = { preventDefault: vi.fn() };
    other.emit('close', event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('preserves macOS native window-close behavior', () => {
    const f = fixture('darwin');
    expect(f.close().preventDefault).not.toHaveBeenCalled();
    expect(f.window.hide).not.toHaveBeenCalled();
  });
});
