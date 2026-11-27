import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFollowUpMode } from './useFollowUpMode';

afterEach(() => vi.restoreAllMocks());

describe('follow-up preference admission', () => {
  it('does not authorize the default mode before the saved setting is read', async () => {
    let finish!: (value: 'queue') => void;
    const pending = new Promise<'queue'>(resolve => { finish = resolve; });
    vi.spyOn(window.electron, 'getSetting').mockReturnValue(pending);
    const { result } = renderHook(() => useFollowUpMode());
    expect(result.current.ready).toBe(false);
    await act(async () => finish('queue'));
    expect(result.current).toMatchObject({ ready: true, mode: 'queue', error: false });
  });

  it('retains a newer cross-window change when the initial read arrives late', async () => {
    let finish!: (value: 'queue') => void;
    let changed!: Parameters<typeof window.electron.on>[1];
    const pending = new Promise<'queue'>(resolve => { finish = resolve; });
    vi.spyOn(window.electron, 'getSetting').mockReturnValue(pending);
    vi.spyOn(window.electron, 'on').mockImplementation((_channel, listener) => { changed = listener; return () => {}; });
    const { result } = renderHook(() => useFollowUpMode());
    act(() => changed({} as Parameters<typeof changed>[0], 'steer'));
    await act(async () => finish('queue'));
    expect(result.current).toMatchObject({ ready: true, mode: 'steer' });
  });

  it('keeps submission gated on a failed setting read', async () => {
    vi.spyOn(window.electron, 'getSetting').mockRejectedValue(new Error('IPC unavailable'));
    const { result } = renderHook(() => useFollowUpMode());
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.ready).toBe(false);
  });
});
