import { act, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ extMethod: vi.fn() }));
vi.mock('./acpConnection', () => ({ getAcpControlClient: async () => mock }));
import {
  useNativeSchedules,
  type ScheduleCatalogEntry,
  type ScheduleUpdateRequest,
} from './nativeSchedules';
import { NATIVE_SCHEDULE_CHANGED } from '../components/schedule/scheduleEvents';
function Catalog() {
  const value = useNativeSchedules();
  return (
    <div>
      {value.status}:{value.records.map((record) => record.title).join(',')}
    </div>
  );
}
it('does not lose a creation notification while the previous catalog read is still pending', async () => {
  let finish!: (value: unknown) => void;
  mock.extMethod.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  mock.extMethod.mockResolvedValue({
    records: [
      {
        id: 'saved',
        sessionId: 'chat',
        status: 'active',
        title: 'New saved task',
        prompt: 'fixture',
        kind: 'every',
        everySeconds: 60,
        scheduledAt: '2026-11-01T00:00:00Z',
      },
    ],
  });
  render(<Catalog />);
  await waitFor(() => expect(mock.extMethod).toHaveBeenCalledTimes(1));
  await act(async () => {
    window.dispatchEvent(new Event(NATIVE_SCHEDULE_CHANGED));
    finish({ records: [] });
  });
  expect(await screen.findByText('ready:New saved task')).toBeInTheDocument();
  expect(mock.extMethod).toHaveBeenCalledTimes(2);
});

it('accepts the paused extension while rejecting malformed native rules', async () => {
  const { readNativeSchedules } = await import('./nativeSchedules');
  const record = {
    id: 'paused-task',
    sessionId: 'chat',
    status: 'paused',
    title: 'Paused',
    prompt: 'fixture',
    kind: 'every',
    everySeconds: 60,
    scheduledAt: '2026-11-01T00:00:00Z',
  } as ScheduleCatalogEntry;
  mock.extMethod.mockResolvedValue({ records: [record] });
  expect((await readNativeSchedules())[0]).toEqual(record);
  mock.extMethod.mockResolvedValue({ records: [{ ...record, everySeconds: 'invalid' }] });
  await expect(readNativeSchedules()).rejects.toThrow();
});

it('records control receipt separately from a failed catalog refresh without logging task text', async () => {
  const { setNativeSchedulePaused } = await import('./nativeSchedules');
  const logInfo = vi.fn();
  const previousLog = window.electron.logInfo;
  window.electron.logInfo = logInfo;
  const record = {
    id: 'timed-task',
    sessionId: 'chat',
    status: 'active' as const,
    title: 'PRIVATE TITLE',
    prompt: 'PRIVATE PROMPT',
    kind: 'every' as const,
    everySeconds: 60,
    scheduledAt: '2026-11-01T00:00:00Z',
  } as ScheduleCatalogEntry;
  const receipt = { id: record.id, changed: true, status: 'paused' };
  mock.extMethod.mockImplementation(async (method: string) => {
    if (method.endsWith('/set-paused')) return receipt;
    throw Error('PRIVATE SERVER ERROR');
  });
  try {
    expect(await setNativeSchedulePaused(record, true)).toEqual(receipt);
    const trace = logInfo.mock.calls.map(([line]) => JSON.parse(line));
    expect(trace.map((row) => row.stage)).toEqual([
      'requested',
      'client_ready',
      'receipt',
      'catalog_settled',
    ]);
    expect(trace[2]).toMatchObject({ changed: true, status: 'paused', refused: false });
    expect(trace[3].catalogState).toBe('error');
    expect(new Set(trace.map((row) => row.operationId)).size).toBe(1);
    expect(JSON.stringify(trace)).not.toContain('PRIVATE');
  } finally {
    window.electron.logInfo = previousLog;
  }
});

it('logging failures do not prevent resume or hide transport failures', async () => {
  const { setNativeSchedulePaused } = await import('./nativeSchedules');
  const previousLog = window.electron.logInfo;
  window.electron.logInfo = () => {
    throw Error('logging failed');
  };
  const record = {
    id: 'resume-task',
    sessionId: 'chat',
    status: 'paused' as const,
    title: 'Task',
    prompt: 'fixture',
    kind: 'every' as const,
    everySeconds: 60,
    scheduledAt: '2026-11-01T00:00:00Z',
  } as ScheduleCatalogEntry;
  mock.extMethod.mockImplementation(async (method: string) =>
    method.endsWith('/set-paused')
      ? { id: record.id, changed: true, status: 'active' }
      : { records: [{ ...record, status: 'active' }] }
  );
  try {
    expect(await setNativeSchedulePaused(record, false)).toMatchObject({
      changed: true,
      status: 'active',
    });
    const original = Error('transport failed');
    mock.extMethod.mockRejectedValue(original);
    await expect(setNativeSchedulePaused(record, false)).rejects.toBe(original);
  } finally {
    window.electron.logInfo = previousLog;
  }
});

const observedRule = {
  id: 'edit-task',
  title: 'Editable',
  prompt: 'original content',
  kind: 'every',
  everySeconds: 60,
  scheduledAt: '2026-11-01T00:00:00Z',
};
const editRequest = () =>
  ({
    id: observedRule.id,
    sessionId: 'chat',
    expected: observedRule,
    change: { kind: 'every', every_seconds: 120 },
  }) as ScheduleUpdateRequest;

it('retries once with the current native record when only the recurring occurrence advances', async () => {
  const { updateNativeSchedule } = await import('./nativeSchedules');
  const advanced = { ...observedRule, scheduledAt: '2026-11-01T00:01:00Z' };
  const saved = { ...advanced, everySeconds: 120, scheduledAt: '2026-11-01T00:03:00Z' };
  let updates = 0;
  const requests: unknown[] = [];
  mock.extMethod.mockImplementation(async (method: string, input: unknown) => {
    if (method.endsWith('/update')) {
      requests.push(input);
      return ++updates === 1
        ? { id: observedRule.id, updated: false, code: 'schedule_conflict' }
        : { id: observedRule.id, updated: true, record: saved };
    }
    return {
      records: [{ ...(updates < 2 ? advanced : saved), sessionId: 'chat', status: 'active' }],
    };
  });
  expect(await updateNativeSchedule(editRequest())).toMatchObject({ updated: true, record: saved });
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual({ ...editRequest(), expected: advanced });
});

it.each([
  { title: 'Another editor title' },
  { prompt: 'Another editor content' },
  { everySeconds: 180 },
  { scheduledAt: '2026-10-31T23:59:00Z' },
])(
  'keeps real concurrent edits and non-forward occurrences as conflicts: %j',
  async (difference) => {
    const { updateNativeSchedule } = await import('./nativeSchedules');
    const current = { ...observedRule, scheduledAt: '2026-11-01T00:01:00Z', ...difference };
    let updates = 0;
    mock.extMethod.mockImplementation(async (method: string) => {
      if (method.endsWith('/update')) {
        updates++;
        return { id: observedRule.id, updated: false, code: 'schedule_conflict' };
      }
      return { records: [{ ...current, sessionId: 'chat', status: 'active' }] };
    });
    expect(await updateNativeSchedule(editRequest())).toMatchObject({ code: 'schedule_conflict' });
    expect(updates).toBe(1);
  }
);

it('does not loop when another native change wins the retry', async () => {
  const { updateNativeSchedule } = await import('./nativeSchedules');
  let updates = 0;
  mock.extMethod.mockImplementation(async (method: string) => {
    if (method.endsWith('/update')) {
      updates++;
      return { id: observedRule.id, updated: false, code: 'schedule_conflict' };
    }
    return {
      records: [
        {
          ...observedRule,
          scheduledAt: '2026-11-01T00:01:00Z',
          sessionId: 'chat',
          status: 'active',
        },
      ],
    };
  });
  expect(await updateNativeSchedule(editRequest())).toMatchObject({ code: 'schedule_conflict' });
  expect(updates).toBe(2);
});
