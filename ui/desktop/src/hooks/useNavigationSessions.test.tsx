import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppEvents } from '../constants/events';

const mocks = vi.hoisted(() => ({ list: vi.fn(), navigate: vi.fn(),
  location: '/codepro', query: '', get: vi.fn() }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useLocation: () => ({ pathname: mocks.location }),
  useSearchParams: () => [new URLSearchParams(mocks.query)],
}));
vi.mock('../contexts/ChatContext', () => ({ useChatContext: () => null }));
vi.mock('../sessions', () => ({ getSessionDisplayName: () => 'Test session' }));
vi.mock('../acp/sessions', () => ({
  acpListRecentSessions: mocks.list,
  acpGetSessionListItem: mocks.get,
  resolveSessionWorkspaceMode: () => 'codepro',
  sessionTypeMatchesWorkspace: () => true,
}));
import { useNavigationSessions } from './useNavigationSessions';

describe('new session sidebar refresh', () => {
  beforeEach(() => { vi.useFakeTimers(); mocks.list.mockReset(); mocks.navigate.mockReset();
    mocks.location = '/codepro'; mocks.query = ''; });
  afterEach(() => { vi.useRealTimers(); });

  it('carries the actually viewed chat into automatic task creation', async () => {
    mocks.location = '/codepro/pair';
    mocks.query = 'resumeSessionId=viewed-chat';
    mocks.get.mockResolvedValue({ id: 'viewed-chat', name: 'Current task', workingDir: '',
      updatedAt: '2026-10-29T00:00:00Z', createdAt: '2026-10-29T00:00:00Z', messageCount: 1 });
    const hook = renderHook(() => useNavigationSessions());
    await act(async () => { hook.result.current.handleNavClick('/schedules'); });
    expect(mocks.navigate).toHaveBeenCalledWith('/codepro/schedules', {
      state: { scheduleSessionId: 'viewed-chat' },
    });
    hook.unmount();
  });

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
