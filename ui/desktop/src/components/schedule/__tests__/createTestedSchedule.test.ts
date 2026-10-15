import { describe, expect, it, vi } from 'vitest';
import type { NewSchedulePayload } from '../ScheduleModal';
import { createTestedSchedule } from '../createTestedSchedule';

const payload = {
  id: 'acceptance-task',
  recipe: {},
  cron: '0 0 14 * * *',
  workspaceMode: 'codepro',
  paused: true,
  tested: false,
} as NewSchedulePayload;

function api() {
  return {
    create: vi.fn().mockResolvedValue({ id: payload.id }),
    runNow: vi.fn().mockResolvedValue({ status: 'completed', sessionId: 'session-id' }),
    unpause: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

describe('createTestedSchedule', () => {
  it('exposes the created task before a model test waits for approval', async () => {
    const scheduleApi = api();
    let finish!: (result: { status: 'completed'; sessionId: string }) => void;
    scheduleApi.runNow.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const created = vi.fn();
    const pending = createTestedSchedule(payload, scheduleApi, created);
    await vi.waitFor(() => expect(scheduleApi.runNow).toHaveBeenCalled());
    expect(created).toHaveBeenCalledWith({ id: payload.id });
    expect(scheduleApi.unpause).not.toHaveBeenCalled();
    finish({ status: 'completed', sessionId: 'session-id' });
    await pending;
    expect(scheduleApi.unpause).toHaveBeenCalledOnce();
  });
  it('enables a schedule only after its test run completes', async () => {
    const scheduleApi = api();

    await createTestedSchedule(payload, scheduleApi);

    expect(scheduleApi.runNow).toHaveBeenCalledWith(payload.id);
    expect(scheduleApi.unpause).toHaveBeenCalledWith(payload.id);
    expect(scheduleApi.remove).not.toHaveBeenCalled();
  });

  it('removes the paused schedule when its test run fails', async () => {
    const scheduleApi = api();
    scheduleApi.runNow.mockRejectedValue(new Error('offline MCP'));

    await expect(createTestedSchedule(payload, scheduleApi)).rejects.toThrow('offline MCP');

    expect(scheduleApi.unpause).not.toHaveBeenCalled();
    expect(scheduleApi.remove).toHaveBeenCalledWith(payload.id);
  });
});
