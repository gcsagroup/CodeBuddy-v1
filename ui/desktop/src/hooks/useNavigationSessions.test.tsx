import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSessionPinned } from '../utils/sessionPins';
import { AppEvents } from '../constants/events';

const mocks = vi.hoisted(() => ({ list: vi.fn(), navigate: vi.fn(), get: vi.fn(), location: { pathname: '/codepro', search: '' } }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useLocation: () => mocks.location,
  useSearchParams: () => [new URLSearchParams(mocks.location.search)],
}));
vi.mock('../contexts/ChatContext', () => ({ useChatContext: () => null }));
vi.mock('../sessions', () => ({ getSessionDisplayName: () => 'Test session' }));
vi.mock('../acp/sessions', () => ({
  acpListRecentSessions: mocks.list,
  acpGetSessionListItem: mocks.get,
  sessionTypeMatchesWorkspace: () => true,
}));
import { useNavigationSessions } from './useNavigationSessions';

it('reorders the owning project immediately after its existing conversation is pinned', async () => {
  localStorage.clear();
  const items = [
    { id: 'new', name: 'New', workingDir: 'D:/project', updatedAt: '2026-11-06' },
    { id: 'old', name: 'Old', workingDir: 'D:/project', updatedAt: '2026-11-01' },
  ];
  mocks.list.mockResolvedValue(items);
  mocks.get.mockImplementation(async id => items.find(item => item.id === id));
  const hook = renderHook(() => useNavigationSessions());
  await act(async () => { await hook.result.current.fetchSessions(); });
  expect(mocks.list).toHaveBeenCalledWith(25, 'unified');
  await act(async () => { setSessionPinned('old', true); });
  expect(hook.result.current.recentSessionsByProject[0].sessions.map(s => s.id)).toEqual(['old', 'new']);
  hook.unmount(); localStorage.clear();
});

describe('new session sidebar refresh', () => {
  it('returns to a new task only when the deleted conversation is currently open', async () => {
    mocks.location = { pathname: '/codepro/pair', search: '?resumeSessionId=existing' };
    mocks.list.mockResolvedValue([]);
    const hook = renderHook(() => useNavigationSessions());
    await act(async () => { window.dispatchEvent(new CustomEvent(AppEvents.SESSION_DELETED, { detail: { sessionId: 'other' } })); });
    expect(mocks.navigate).not.toHaveBeenCalled();
    await act(async () => { window.dispatchEvent(new CustomEvent(AppEvents.SESSION_DELETED, { detail: { sessionId: 'existing' } })); });
    expect(mocks.navigate).toHaveBeenCalledWith('/codepro', { replace: true });
    hook.unmount();
  });
  beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); mocks.get.mockReset().mockResolvedValue({ id: "existing", workingDir: "D:/fixture", name: "Existing", messageCount: 1 }); mocks.list.mockReset(); mocks.navigate.mockClear(); mocks.location = { pathname: '/codepro', search: '' }; });
  afterEach(() => { vi.useRealTimers(); });

  it('restores an unarchived task to the sidebar without creating or opening another chat', async () => {
    const restored = { id: 'archived-chat', name: 'Restored task', workingDir: '', messageCount: 2 };
    mocks.list.mockResolvedValue([restored]);
    const hook = renderHook(() => useNavigationSessions());
    expect(hook.result.current.recentSessions).toEqual([]);
    await act(async () => {
      window.dispatchEvent(new CustomEvent(AppEvents.SESSION_UNARCHIVED, { detail: { sessionId: restored.id } }));
    });
    expect(hook.result.current.recentSessions).toEqual([restored]);
    expect(mocks.navigate).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('keeps a viewed archived session out of the sidebar after archive refresh', async () => {
    mocks.location = { pathname: '/codepro/pair', search: '?resumeSessionId=archived-chat' };
    mocks.get.mockResolvedValue({
      id: 'archived-chat',
      name: 'Archived task',
      workingDir: '',
      updatedAt: '2026-11-02',
      createdAt: '2026-11-02',
      messageCount: 1,
      archivedAt: '2026-11-02',
    });
    mocks.list.mockResolvedValue([]);
    const hook = renderHook(() => useNavigationSessions());
    await act(async () => {});
    expect(hook.result.current.recentSessions).toEqual([]);
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(AppEvents.SESSION_ARCHIVED, { detail: { sessionId: 'archived-chat' } })
      );
    });
    expect(mocks.list).toHaveBeenCalledOnce();
    expect(hook.result.current.recentSessions).toEqual([]);
    hook.unmount();
  });

  it.each(['/codepro', '/codepro/pair', '/pair'])('keeps the current conversation when opening toolbox from %s', async pathname => {
    mocks.location = { pathname, search: '?resumeSessionId=existing' };
    const hook = renderHook(() => useNavigationSessions());
    await act(async () => hook.result.current.handleNavClick('/toolbox'));
    expect(mocks.navigate).toHaveBeenCalledWith(`${pathname.startsWith('/codepro') ? '/codepro' : ''}/toolbox?sessionId=existing`);
  });

  it('does not attach an unrelated conversation from the sidebar to a new task', () => {
    const hook = renderHook(() => useNavigationSessions());
    act(() => hook.result.current.handleNavClick('/toolbox'));
    expect(mocks.navigate).toHaveBeenCalledWith('/codepro/toolbox');
  });

  it('opens custom agents for the viewed chat but never reuses that target from a new-task page', async () => {
    mocks.location = { pathname: '/codepro/pair', search: '?resumeSessionId=viewed-chat' };
    const hook = renderHook(() => useNavigationSessions());
    await act(async () => hook.result.current.handleNavClick('/custom-agents'));
    expect(mocks.navigate).toHaveBeenLastCalledWith('/codepro/custom-agents?sessionId=viewed-chat', { state: undefined });
    mocks.location = { pathname: '/codepro', search: '' };
    hook.rerender();
    act(() => hook.result.current.handleNavClick('/custom-agents'));
    expect(mocks.navigate).toHaveBeenLastCalledWith('/codepro/custom-agents', { state: undefined });
    hook.unmount();
  });

  it('carries the actually viewed chat into automatic task creation', async () => {
    mocks.location = { pathname: '/codepro/pair', search: '?resumeSessionId=viewed-chat' };
    mocks.get.mockResolvedValue({ id: 'viewed-chat', name: 'Current task', workingDir: '',
      updatedAt: '2026-10-29T00:00:00Z', createdAt: '2026-10-29T00:00:00Z', messageCount: 1 });
    const hook = renderHook(() => useNavigationSessions());
    await act(async () => {
      hook.result.current.handleNavClick('/schedules');
    });
    expect(mocks.navigate).toHaveBeenCalledWith('/codepro/schedules', {
      state: { scheduleSessionId: 'viewed-chat' },
    });
    hook.unmount();
  });

  it('includes slow requests in the ten second refresh window', async () => {
    let finish!: (value: []) => void;
    mocks.list.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const hook = renderHook(() => useNavigationSessions());
    act(() => window.dispatchEvent(new CustomEvent(AppEvents.SESSION_CREATED)));
    expect(mocks.list).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11000);
      finish([]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(mocks.list).toHaveBeenCalledTimes(1);
    // A later, distinct creation can refresh again.
    act(() => window.dispatchEvent(new CustomEvent(AppEvents.SESSION_CREATED)));
    expect(mocks.list).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it('does not restart polling when an in-flight request finishes after unmount', async () => {
    let finish!: (value: []) => void;
    mocks.list.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const hook = renderHook(() => useNavigationSessions());
    act(() => window.dispatchEvent(new CustomEvent(AppEvents.SESSION_CREATED)));
    hook.unmount();
    await act(async () => {
      finish([]);
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });
});


it('keeps old pinned sessions beyond the recent list, excludes archived pins and restores them on unarchive', async () => {
  localStorage.clear();
  mocks.list.mockResolvedValue([]);
  const old = { id: 'old-pin', name: 'Old chat', workingDir: '', messageCount: 2 };
  mocks.get.mockResolvedValue(old);
  setSessionPinned(old.id, true);
  const hook = renderHook(() => useNavigationSessions());
  await act(async () => {});
  expect(hook.result.current.pinnedSessions).toEqual([old]);
  mocks.get.mockResolvedValue({ ...old, archivedAt: '2026-11-05' });
  await act(async () => { window.dispatchEvent(new CustomEvent(AppEvents.SESSION_ARCHIVED, { detail: { sessionId: old.id } })); });
  expect(hook.result.current.pinnedSessions).toEqual([]);
  mocks.get.mockResolvedValue(old);
  await act(async () => { window.dispatchEvent(new CustomEvent(AppEvents.SESSION_UNARCHIVED, { detail: { sessionId: old.id } })); });
  expect(hook.result.current.pinnedSessions).toEqual([old]);
  hook.unmount();
  localStorage.clear();
});
