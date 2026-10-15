import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppEvents } from '../constants/events';

const mocks = vi.hoisted(() => ({ list: vi.fn(), navigate: vi.fn() }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useLocation: () => ({ pathname: '/codepro' }),
  useSearchParams: () => [new URLSearchParams()],
}));
vi.mock('../contexts/ChatContext', () => ({ useChatContext: () => null }));
vi.mock('../sessions', () => ({ getSessionDisplayName: () => 'Test session' }));
vi.mock('../acp/sessions', () => ({
  acpListRecentSessions: mocks.list,
  acpGetSessionListItem: vi.fn(),
  resolveSessionWorkspaceMode: () => 'codepro',
  sessionTypeMatchesWorkspace: () => true,
}));
import { useNavigationSessions } from './useNavigationSessions';

describe('new session sidebar refresh', () => {
  beforeEach(() => { vi.useFakeTimers(); mocks.list.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('includes slow requests in the ten second refresh window', async () => {
    let finish!: (value: []) => void;
    mocks.list.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const hook = renderHook(() => useNavigationSessions());
    act(() => window.dispatchEvent(new CustomEvent(AppEvents.SESSION_CREATED)));
    expect(mocks.list).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(11000); finish([]); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(mocks.list).toHaveBeenCalledTimes(1);
    // A later, distinct creation can refresh again.
    act(() => window.dispatchEvent(new CustomEvent(AppEvents.SESSION_CREATED)));
    expect(mocks.list).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it('does not restart polling when an in-flight request finishes after unmount', async () => {
    let finish!: (value: []) => void;
    mocks.list.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const hook = renderHook(() => useNavigationSessions());
    act(() => window.dispatchEvent(new CustomEvent(AppEvents.SESSION_CREATED)));
    hook.unmount();
    await act(async () => { finish([]); await vi.advanceTimersByTimeAsync(20000); });
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });
});
