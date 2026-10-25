import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ScheduleDetailView from '../ScheduleDetailView';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import {
  acpListSchedules,
  acpListScheduleSessions,
  acpRunScheduleNow,
  acpKillRunningJob,
} from '../../../acp/schedules';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('../../../hooks/useNavigation', () => ({ useNavigation: () => navigate }));
vi.mock('../../../acp/schedules', () => ({
  acpListSchedules: vi.fn(),
  acpListScheduleSessions: vi.fn(),
  acpRunScheduleNow: vi.fn(),
  acpPauseSchedule: vi.fn(),
  acpUnpauseSchedule: vi.fn(),
  acpUpdateSchedule: vi.fn(),
  acpKillRunningJob: vi.fn(),
  acpInspectRunningJob: vi.fn(),
}));
vi.mock('../ScheduleModal', () => ({ ScheduleModal: () => null }));
vi.mock('../../../utils/analytics', () => ({
  trackScheduleRunNow: vi.fn(),
  getErrorType: vi.fn(),
}));
vi.mock('../../../toasts', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it('keeps inspect and stop usable while a manual run RPC is still pending', async () => {
  vi.useFakeTimers();
  const job = { id: 'manual-job', cron: '0 * * * * *', paused: true, currentlyRunning: false };
  vi.mocked(acpListSchedules).mockResolvedValue([job as never]);
  vi.mocked(acpListScheduleSessions).mockResolvedValue([]);
  let finish!: (value: Awaited<ReturnType<typeof acpRunScheduleNow>>) => void;
  vi.mocked(acpRunScheduleNow).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  vi.mocked(acpKillRunningJob).mockResolvedValue({ message: 'Cancelled' } as never);
  const view = render(<ScheduleDetailView scheduleId={job.id} onNavigateBack={vi.fn()} />, {
    wrapper: IntlTestWrapper,
  });
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.click(screen.getByRole('button', { name: 'Run Schedule Now' }));
  vi.mocked(acpListSchedules).mockResolvedValue([
    { ...job, currentlyRunning: true, currentSessionId: 'live' } as never,
  ]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(screen.getByRole('button', { name: 'Run Schedule Now' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Inspect Running Job' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Kill Running Job' })).toBeEnabled();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Kill Running Job' }));
  });
  expect(acpKillRunningJob).toHaveBeenCalledWith(job.id);
  await act(async () => {
    finish({ status: 'cancelled', sessionId: 'live' } as never);
  });
  view.unmount();
});

it('exposes a newly started background session without replacing the details with a loading screen', async () => {
  vi.useFakeTimers();
  const job = { id: 'approval-job', cron: '0 * * * * *', paused: true, currentlyRunning: false };
  vi.mocked(acpListSchedules).mockResolvedValue([job as never]);
  vi.mocked(acpListScheduleSessions).mockResolvedValue([]);
  const view = render(<ScheduleDetailView scheduleId={job.id} onNavigateBack={vi.fn()} />, {
    wrapper: IntlTestWrapper,
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByText('No sessions found for this schedule.')).toBeInTheDocument();
  vi.mocked(acpListSchedules).mockResolvedValue([
    { ...job, currentlyRunning: true, currentSessionId: 'pending-session' } as never,
  ]);
  vi.mocked(acpListScheduleSessions).mockResolvedValue([
    {
      sessionId: 'pending-session',
      cwd: 'D:/fixture',
      title: 'Approval session',
      updatedAt: new Date().toISOString(),
    },
  ]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(screen.queryByText('Loading sessions...')).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('Approval session'));
  expect(navigate).toHaveBeenCalledWith('pair', {
    disableAnimation: true,
    resumeSessionId: 'pending-session',
  });
  view.unmount();
  const calls = vi.mocked(acpListSchedules).mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  expect(acpListSchedules).toHaveBeenCalledTimes(calls);
});
