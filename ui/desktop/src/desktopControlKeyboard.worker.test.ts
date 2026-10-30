import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createDesktopEscape } from './desktopControlKeyboard';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const mockedSpawn = vi.fn();
  return { ...actual, spawn: mockedSpawn, default: { ...actual, spawn: mockedSpawn } };
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('Mac Escape worker routing', () => {
  it('arms only the latest token and ignores old-worker events after failure', () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    const worker = () => Object.assign(new EventEmitter(), {
      stdin: Object.assign(new EventEmitter(), { write: vi.fn() }),
      stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
      stderr: { resume: vi.fn() }, kill: vi.fn(),
    });
    const first = worker(), second = worker();
    vi.mocked(spawn).mockReturnValueOnce(first as never).mockReturnValueOnce(second as never);
    const cancel = vi.fn(), ready = vi.fn();
    const keyboard = createDesktopEscape(cancel, ready, '/native/qwen-computer-runtime');
    keyboard.arm('old'); keyboard.arm('new');
    expect(spawn).toHaveBeenCalledWith('/native/qwen-computer-runtime', ['--watch-escape'], { windowsHide: true });
    first.stdout.emit('data', 'ready\n');
    expect(first.stdin.write).toHaveBeenLastCalledWith('arm new\n');
    first.stdout.emit('data', 'armed old\ncancel old\narmed new\ncancel new\n');
    expect(cancel.mock.calls).toEqual([['new']]);
    expect(ready).toHaveBeenLastCalledWith(true);
    first.emit('error', Error('lost monitor'));
    expect(ready).toHaveBeenLastCalledWith(false);
    keyboard.arm('next');
    first.stdout.emit('data', 'cancel next\n');
    expect(cancel).toHaveBeenCalledTimes(1);
    second.stdout.emit('data', 'ready\narmed next\n');
    keyboard.arm('');
    expect(second.stdin.write).toHaveBeenLastCalledWith('arm \n');
    keyboard.close();
    expect(second.kill).toHaveBeenCalled();
  });
});
