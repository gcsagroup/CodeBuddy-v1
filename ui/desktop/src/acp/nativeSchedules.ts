import { useSyncExternalStore } from 'react';
import { getAcpControlClient } from './acpConnection';
import { NATIVE_SCHEDULE_CHANGED } from '../components/schedule/scheduleEvents';
import { TYPERT } from '../../../../runtime/harness/node_modules/@deepseek-ai/dsh-schedule/lib/typert.host.js';
import type {
  ScheduleCatalogEntry as NativeScheduleCatalogEntry,
  ScheduleRecord,
  ScheduleUpdateRequest,
  ScheduleUpdateResult,
  ScheduleDeliveryHistoryResult,
} from '../../../../runtime/harness/node_modules/@deepseek-ai/dsh-schedule/lib/types/client.js';
export type ScheduleCatalogEntry = ScheduleRecord & {
  sessionId: NativeScheduleCatalogEntry['sessionId'];
  status: 'active' | 'paused' | 'inactive';
  lastDelivery?: NativeScheduleCatalogEntry['lastDelivery'];
};
export type { ScheduleRecord, ScheduleUpdateRequest };

// Consume the exact codecs shipped with the pinned Host; the UI does not own
// a parallel timing validator or completion interpretation.
type Codec = { create: () => { parse: (value: unknown) => unknown } };
const descriptors = (TYPERT as { invocations: { method: string; result: Codec }[] }).invocations;
async function call(action: string, input: Record<string, unknown> = {}) {
  const client = await getAcpControlClient();
  return client.extMethod(`_goose/unstable/native-schedules/${action}`, input);
}
export async function readNativeSchedules(): Promise<ScheduleCatalogEntry[]> {
  const result = (await call('catalog')) as { records?: unknown };
  if (!Array.isArray(result.records)) throw new TypeError('Invalid schedule catalog');
  // Validate every native field with the pinned codec; only paused is local.
  const statuses = result.records.map((row: { status?: unknown }) => row?.status);
  const records = descriptors
    .find((item) => item.method === 'catalog')!
    .result.create()
    .parse(
      result.records.map((row: { status?: unknown }) =>
        row?.status === 'paused' ? { ...row, status: 'inactive' } : row
      )
    ) as NativeScheduleCatalogEntry[];
  return records.map((row, index) => ({
    ...row,
    status: statuses[index] === 'paused' ? 'paused' : row.status,
  })) as ScheduleCatalogEntry[];
}
export async function updateNativeSchedule(
  input: ScheduleUpdateRequest
): Promise<ScheduleUpdateResult> {
  const parse = (value: unknown) =>
    descriptors
      .find((item) => item.method === 'update')!
      .result.create()
      .parse(value) as ScheduleUpdateResult;
  let parsed = parse(await call('update', { ...input }));
  if (
    'code' in parsed &&
    parsed.code === 'schedule_conflict' &&
    ['every', 'daily', 'weekly', 'cron'].includes(input.expected.kind)
  ) {
    const latest = (await readNativeSchedules()).find(
      (row) => row.id === input.id && row.sessionId === input.sessionId && row.status !== 'inactive'
    );
    if (latest) {
      const current = nativeScheduleRecord(latest);
      const { scheduledAt: previousTime, ...previousRule } = input.expected;
      const { scheduledAt: currentTime, ...currentRule } = current;
      const previousFields = previousRule as Record<string, unknown>;
      const currentFields = currentRule as Record<string, unknown>;
      // Refresh only a recurring occurrence that advanced with the complete rule
      // unchanged. The native owner still checks the full fresh record atomically.
      // One retry bounds races; never silently overwrite another editor's rule.
      if (
        Date.parse(currentTime) > Date.parse(previousTime) &&
        Object.keys(previousFields).length === Object.keys(currentFields).length &&
        Object.keys(previousFields).every(
          (key) => JSON.stringify(previousFields[key]) === JSON.stringify(currentFields[key])
        )
      ) {
        parsed = parse(await call('update', { ...input, expected: current }));
      }
    }
  }
  await refreshNativeSchedules();
  return parsed;
}
export async function setNativeSchedulePaused(record: ScheduleCatalogEntry, paused: boolean) {
  const started = performance.now();
  const operationId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const trace = (stage: string, details: Record<string, string | boolean | undefined> = {}) => {
    try {
      window.electron?.logInfo(
        JSON.stringify({
          tag: 'schedule_control_timing',
          source: 'ui',
          operationId,
          taskId: record.id,
          sessionId: record.sessionId,
          action: paused ? 'pause' : 'resume',
          stage,
          at: new Date().toISOString(),
          elapsedMs: Math.round(performance.now() - started),
          ...details,
        })
      );
    } catch {
      /* Logging must not change control behavior. */
    }
  };
  trace('requested');
  try {
    const client = await getAcpControlClient();
    trace('client_ready');
    const result = (await client.extMethod('_goose/unstable/native-schedules/set-paused', {
      id: record.id,
      sessionId: record.sessionId,
      expected: nativeScheduleRecord(record),
      expectedStatus: record.status,
      paused,
    })) as {
      id?: string;
      changed?: boolean;
      status?: ScheduleCatalogEntry['status'];
      code?: string;
    };
    if (
      !result ||
      typeof result !== 'object' ||
      (result.code === undefined &&
        (result.id !== record.id ||
          typeof result.changed !== 'boolean' ||
          !['active', 'paused', 'inactive'].includes(result.status ?? '')))
    )
      throw new TypeError('Invalid schedule pause receipt');
    trace('receipt', {
      changed: result.changed === true,
      status: ['active', 'paused', 'inactive'].includes(result.status ?? '')
        ? result.status
        : undefined,
      refused: result.code !== undefined,
    });
    await refreshNativeSchedules();
    // This is the published catalog, not a claim that the screen has painted.
    trace('catalog_settled', {
      catalogState: snapshot.status,
      observedStatus: snapshot.records.find((row) => row.id === record.id)?.status,
    });
    return result;
  } catch (error) {
    trace('failed');
    throw error;
  }
}
export async function deleteNativeSchedule(record: ScheduleCatalogEntry) {
  const result = await call('delete', { id: record.id, sessionId: record.sessionId });
  const parsed = descriptors
    .find((item) => item.method === 'delete')!
    .result.create()
    .parse(result) as { deleted: boolean };
  await refreshNativeSchedules();
  return parsed;
}
export async function readNativeScheduleHistory(
  record: ScheduleCatalogEntry,
  before?: string
): Promise<ScheduleDeliveryHistoryResult> {
  const value = await call('history', {
    sessionId: record.sessionId,
    id: record.id,
    limit: 20,
    ...(before ? { before } : {}),
  });
  return descriptors
    .find((item) => item.method === 'history')!
    .result.create()
    .parse(value) as ScheduleDeliveryHistoryResult;
}
export async function readLegacySchedules() {
  return (await call('legacy-list')) as {
    jobs: { id: string; title: string; cron: string; executionMode: string }[];
  };
}
interface Snapshot {
  records: ScheduleCatalogEntry[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  readRequest: number;
  readSettled: number;
}
let snapshot: Snapshot = { records: [], status: 'idle', readRequest: 0, readSettled: 0 };
let pending: Promise<void> | undefined;
let invalidated = false;
const listeners = new Set<() => void>();
const publish = (next: Snapshot) => {
  snapshot = next;
  listeners.forEach((listener) => listener());
};
export function refreshNativeSchedules(): Promise<void> {
  invalidated = true;
  if (pending) return pending;
  pending = (async () => {
    while (invalidated) {
      invalidated = false;
      const readRequest = snapshot.readRequest + 1;
      publish({
        ...snapshot,
        readRequest,
        status: snapshot.records.length ? snapshot.status : 'loading',
        error: undefined,
      });
      try {
        const records = await readNativeSchedules();
        if (!invalidated)
          publish({ records, status: 'ready', readRequest, readSettled: readRequest });
      } catch (error) {
        if (!invalidated)
          publish({
            ...snapshot,
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
      }
    }
  })().finally(() => {
    pending = undefined;
    if (invalidated) void refreshNativeSchedules();
  });
  return pending;
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener(NATIVE_SCHEDULE_CHANGED, refreshNativeSchedules);
    window.addEventListener('focus', refreshNativeSchedules);
    void refreshNativeSchedules();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      window.removeEventListener(NATIVE_SCHEDULE_CHANGED, refreshNativeSchedules);
      window.removeEventListener('focus', refreshNativeSchedules);
    }
  };
}
export function useNativeSchedules() {
  return useSyncExternalStore(subscribe, () => snapshot);
}
export function nativeScheduleRecord(entry: ScheduleCatalogEntry): ScheduleRecord {
  const { sessionId: _session, status: _status, lastDelivery: _delivery, ...record } = entry;
  return record;
}
