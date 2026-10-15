import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ScheduleDetailView from '../ScheduleDetailView';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import { acpListSchedules, acpListScheduleSessions } from '../../../acp/schedules';

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
