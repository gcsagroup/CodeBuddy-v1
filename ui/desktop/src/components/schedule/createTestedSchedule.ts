import type { ScheduledJobDto } from '@aaif/goose-sdk';
import {
  acpCreateSchedule,
  acpDeleteSchedule,
  acpRunScheduleNow,
  acpUnpauseSchedule,
} from '../../acp/schedules';
import type { NewSchedulePayload } from './ScheduleModal';

interface ScheduleCreationApi {
  create: (payload: NewSchedulePayload) => Promise<ScheduledJobDto>;
  runNow: typeof acpRunScheduleNow;
  unpause: typeof acpUnpauseSchedule;
  remove: typeof acpDeleteSchedule;
}

const defaultApi: ScheduleCreationApi = {
  create: acpCreateSchedule,
  runNow: acpRunScheduleNow,
  unpause: acpUnpauseSchedule,
  remove: acpDeleteSchedule,
};

export async function createTestedSchedule(
  payload: NewSchedulePayload,
  api: ScheduleCreationApi = defaultApi,
  onCreated?: (schedule: ScheduledJobDto) => void
): Promise<void> {
  const created = await api.create(payload);
  onCreated?.(created);
  try {
    const testRun = await api.runNow(created.id);
    if (testRun.status !== 'completed') {
      throw new Error('The test run did not complete; the automatic task remains paused.');
    }
    await api.unpause(created.id);
  } catch (error) {
    try {
      await api.remove(created.id);
    } catch (rollbackError) {
      console.error(`Failed to roll back automatic task "${created.id}":`, rollbackError);
    }
    throw error;
  }
}
