import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceCall } from './VoiceCall';

const events = () => ({
  status: vi.fn(),
  ready: vi.fn(),
  level: vi.fn(),
  text: vi.fn(),
  ended: vi.fn(),
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Voice call microphone lifecycle', () => {
  it('reports denied permission without starting signaling', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')),
      },
    });
    const callbacks = events();
    await new VoiceCall(callbacks).start({ name: 'test', prompt: 'test' });
    expect(callbacks.ended).toHaveBeenCalledWith(expect.stringContaining('权限被拒绝'));
    expect(callbacks.ready).not.toHaveBeenCalled();
  });

  it('releases a microphone that resolves after hangup', async () => {
    let resolve!: (stream: MediaStream) => void;
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: () =>
          new Promise<MediaStream>((done) => {
            resolve = done;
          }),
      },
    });
    const callbacks = events();
    const call = new VoiceCall(callbacks);
    const starting = call.start({ name: 'test', prompt: 'test' });
    call.stop();
    const stop = vi.fn();
    resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await starting;
    expect(stop).toHaveBeenCalledOnce();
    expect(callbacks.ended).toHaveBeenCalledOnce();
    expect(callbacks.ready).not.toHaveBeenCalled();
  });

  it('times out a microphone permission request and stops late tracks', async () => {
    vi.useFakeTimers();
    let resolve!: (stream: MediaStream) => void;
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: () =>
          new Promise<MediaStream>((done) => {
            resolve = done;
          }),
      },
    });
    const callbacks = events();
    const starting = new VoiceCall(callbacks).start({ name: 'test', prompt: 'test' });
    await vi.advanceTimersByTimeAsync(10000);
    expect(callbacks.ended).toHaveBeenCalledWith(expect.stringContaining('超时'));
    const stop = vi.fn();
    resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await starting;
    expect(stop).toHaveBeenCalledOnce();
  });
});
