import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { readPreferences, savePreferences } from '../acp/preferences';
import { useInitialPermissionPreset } from './SessionPermissionSummary';

vi.mock('../acp/preferences', () => ({ readPreferences: vi.fn(), savePreferences: vi.fn() }));
const snapshot = (revision: number, value: string) => ({
  revision, values: [{ key: 'gooseMode' as const, value, isMutable: true }],
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readPreferences).mockResolvedValue(snapshot(1, 'workspace-write'));
});

it('keeps the saved permission across navigation and rejects a stale read', async () => {
  let finish!: (value: Awaited<ReturnType<typeof readPreferences>>) => void;
  const delayed = new Promise<Awaited<ReturnType<typeof readPreferences>>>(resolve => { finish = resolve; });
  vi.mocked(readPreferences).mockReturnValueOnce(delayed);
  vi.mocked(savePreferences).mockResolvedValueOnce(snapshot(2, 'read-only'));
  const hook = renderHook(useInitialPermissionPreset);
  await act(() => hook.result.current[1]('read-only'));
  expect(savePreferences).toHaveBeenCalledWith([{ key: 'gooseMode', value: 'read-only', isMutable: true }]);
  await act(async () => finish(snapshot(1, 'workspace-write')));
  expect(hook.result.current[0]).toBe('read-only');
  hook.unmount();
  vi.mocked(readPreferences).mockResolvedValueOnce(snapshot(2, 'read-only'));
  const next = renderHook(useInitialPermissionPreset);
  await waitFor(() => expect(next.result.current[0]).toBe('read-only'));
});

it('keeps the confirmed permission when saving fails', async () => {
  vi.mocked(savePreferences).mockRejectedValueOnce(new Error('offline'));
  const hook = renderHook(useInitialPermissionPreset);
  await waitFor(() => expect(hook.result.current[0]).toBe('workspace-write'));
  await expect(hook.result.current[1]('danger-full-access')).rejects.toThrow('offline');
  expect(hook.result.current[0]).toBe('workspace-write');
});
