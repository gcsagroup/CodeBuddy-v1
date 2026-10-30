import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { readPreferences } from '../acp/preferences';
import { clearNewTaskDraft } from '../utils/newTaskDraft';
import { useInitialPermissionPreset } from './SessionPermissionSummary';

vi.mock('../acp/preferences', () => ({ readPreferences: vi.fn() }));
beforeEach(() => {
  clearNewTaskDraft('code');
  clearNewTaskDraft('codepro');
  vi.mocked(readPreferences).mockResolvedValue({ revision: 1, values: [{ key: 'gooseMode', value: 'workspace-write' }] } as never);
});

it('keeps the unsent permission across navigation, isolates modes, and clears after successful creation', async () => {
  const first = renderHook(() => useInitialPermissionPreset('codepro'));
  await waitFor(() => expect(first.result.current[0]).toBe('workspace-write'));
  act(() => first.result.current[1]('danger-full-access'));
  first.unmount();
  const returned = renderHook(() => useInitialPermissionPreset('codepro'));
  await act(async () => {});
  expect(returned.result.current[0]).toBe('danger-full-access');
  const ordinary = renderHook(() => useInitialPermissionPreset('code'));
  await waitFor(() => expect(ordinary.result.current[0]).toBe('workspace-write'));
  returned.unmount();
  act(() => clearNewTaskDraft('codepro'));
  const next = renderHook(() => useInitialPermissionPreset('codepro'));
  await waitFor(() => expect(next.result.current[0]).toBe('workspace-write'));
});

it('does not let a delayed default overwrite an explicit choice', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(readPreferences).mockReturnValue(new Promise(resolve => { finish = resolve; }) as never);
  const hook = renderHook(() => useInitialPermissionPreset('codepro'));
  act(() => hook.result.current[1]('read-only'));
  await act(async () => finish({ revision: 1, values: [{ key: 'gooseMode', value: 'danger-full-access' }] }));
  expect(hook.result.current[0]).toBe('read-only');
});
