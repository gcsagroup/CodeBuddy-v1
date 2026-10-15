import { describe, expect, it } from 'vitest';
import type { ScheduledJobDto } from '@aaif/goose-sdk';
import { schedulesForWorkspace } from './scheduleWorkspace';

function schedule(id: string, workspaceMode: 'code' | 'codepro'): ScheduledJobDto {
  return {
    id,
    source: `${id}.yaml`,
    cron: '0 0 0 * * *',
    currentlyRunning: false,
    paused: false,
    tested: true,
    workspaceMode,
  };
}

describe('schedulesForWorkspace', () => {
  const schedules = [schedule('code-job', 'code'), schedule('codepro-job', 'codepro')];

  it('keeps Code jobs out of CodePro', () => {
    expect(schedulesForWorkspace(schedules, 'codepro').map(({ id }) => id)).toEqual([
      'codepro-job',
    ]);
  });

  it('keeps CodePro jobs out of Code', () => {
    expect(schedulesForWorkspace(schedules, 'code').map(({ id }) => id)).toEqual(['code-job']);
  });
});
