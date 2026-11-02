import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useNativeSchedulePanel } from './useNativeSchedulePanel';
import { openNativeSchedule } from './scheduleEvents';

const state = vi.hoisted(() => ({
  location: { pathname: '/codepro/pair', search: '?resumeSessionId=a' },
  records: [
    { id: 'task-a', sessionId: 'a' },
    { id: 'task-b', sessionId: 'b' },
  ],
}));
vi.mock('react-router-dom', () => ({ useLocation: () => state.location }));
vi.mock('../../acp/nativeSchedules', () => ({
  useNativeSchedules: () => ({ records: state.records }),
}));
beforeEach(() => {
  state.location = { pathname: '/codepro/pair', search: '?resumeSessionId=a' };
  state.records = [
    { id: 'task-a', sessionId: 'a' },
    { id: 'task-b', sessionId: 'b' },
  ];
});
it('switches between each linked task and the ordinary workspace with the chat route', () => {
  const { result, rerender } = renderHook(useNativeSchedulePanel);
  expect(result.current.id).toBe('task-a');
  state.location.search = '?resumeSessionId=b';
  rerender();
  expect(result.current.id).toBe('task-b');
  state.location.search = '?resumeSessionId=ordinary';
  rerender();
  expect(result.current.id).toBeNull();
  state.location.search = '?resumeSessionId=a';
  rerender();
  expect(result.current.id).toBe('task-a');
});
it('respects manual close while refreshing, then opens by default on return', () => {
  const { result, rerender } = renderHook(useNativeSchedulePanel);
  act(() => result.current.close());
  state.records = [...state.records];
  rerender();
  expect(result.current.id).toBeNull();
  state.location.search = '?resumeSessionId=b';
  rerender();
  state.location.search = '?resumeSessionId=a';
  rerender();
  expect(result.current.id).toBe('task-a');
});
it('uses the catalog when creation arrives, preserves explicit selection, and clears a deleted task', () => {
  state.records = [];
  const { result, rerender } = renderHook(useNativeSchedulePanel);
  expect(result.current.id).toBeNull();
  state.records = [
    { id: 'task-a', sessionId: 'a' },
    { id: 'task-a2', sessionId: 'a' },
  ];
  rerender();
  expect(result.current.id).toBe('task-a');
  act(() => openNativeSchedule('task-a2'));
  expect(result.current.id).toBe('task-a2');
  state.records = [];
  rerender();
  expect(result.current.id).toBeNull();
});
it('opens list selections but never carries them into an unrelated chat', () => {
  state.location = { pathname: '/codepro/schedules', search: '' };
  const { result, rerender } = renderHook(useNativeSchedulePanel);
  expect(result.current.id).toBeNull();
  act(() => openNativeSchedule('task-b'));
  expect(result.current.id).toBe('task-b');
  state.location = { pathname: '/codepro/pair', search: '?resumeSessionId=a' };
  rerender();
  expect(result.current.id).toBe('task-a');
});
