import type { ScheduledJobDto } from '@aaif/goose-sdk';
import type { WorkspaceMode } from './navigationUtils';

export function schedulesForWorkspace(
  schedules: ScheduledJobDto[],
  workspaceMode: WorkspaceMode
): ScheduledJobDto[] {
  return schedules.filter((schedule) => schedule.workspaceMode === workspaceMode);
}
