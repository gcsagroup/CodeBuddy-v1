import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { PropsWithChildren } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import { NativeScheduleDetails } from '../NativeScheduleDetails';
const mock = vi.hoisted(() => ({
  update: vi.fn(),
  pause: vi.fn(),
  history: vi.fn(),
  records: [
    {
      id: 'task1',
      sessionId: 'chat1',
      status: 'active',
      title: 'Saved title',
      prompt: 'Current instruction',
      kind: 'every',
      everySeconds: 60,
      scheduledAt: '2026-11-01T01:00:00Z',
    },
  ],
}));
vi.mock('../../../acp/sessions', () => ({ acpGetSessionListItem: async () => ({ id: 'chat1' }) }));
vi.mock('../../../acp/nativeSchedules', () => ({
  useNativeSchedules: () => ({ records: mock.records, status: 'ready' }),
  refreshNativeSchedules: vi.fn(),
  nativeScheduleRecord: (entry: Record<string, unknown>) => {
    const { sessionId: _session, status: _status, ...record } = entry;
    return record;
  },
  updateNativeSchedule: mock.update,
  setNativeSchedulePaused: mock.pause,
  deleteNativeSchedule: vi.fn(),
  readNativeScheduleHistory: mock.history,
}));
beforeEach(() => {
  vi.clearAllMocks();
  mock.records[0].status = 'active';
  mock.pause.mockResolvedValue({ id: 'task1', changed: true, status: 'paused' });
  mock.update.mockResolvedValue({ id: 'task1', updated: false, code: 'schedule_conflict' });
  mock.history.mockResolvedValue({
    id: 'task1',
    records: [
      { messageId: 'm1', scheduledAt: '2026-10-30T00:00:00Z', deliveredAt: '2026-10-30T00:00:01Z' },
    ],
    earlierRecordsUnavailable: true,
  });
});
it('saves against the observed native record and retains the draft after a conflict', async () => {
  render(<NativeScheduleDetails id="task1" onClose={vi.fn()} />, { wrapper: TestWrapper });
  const name = await screen.findByRole('textbox', { name: 'Task name' });
  fireEvent.change(name, { target: { value: 'My edited title' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(mock.update).toHaveBeenCalled());
  const request = mock.update.mock.calls[0][0];
  expect(request.expected.title).toBe('Saved title');
  expect(request.expected.scheduledAt).toBe('2026-11-01T01:00:00Z');
  expect(request.title).toBe('My edited title');
  expect(request.change).toBeUndefined();
  expect(request.id).toBe('task1');
  expect(await screen.findByRole('alert')).toHaveTextContent('The task changed');
  expect(name).toHaveValue('My edited title');
});
it('shows delivery semantics and never replaces a missing historical instruction with the current one', async () => {
  render(<NativeScheduleDetails id="task1" onClose={vi.fn()} />, { wrapper: TestWrapper });
  fireEvent.click(screen.getByRole('tab', { name: 'Task records' }));
  expect(await screen.findByText('The original instruction was not saved.')).toBeInTheDocument();
  expect(screen.getByText('Some earlier delivery records are unavailable.')).toBeInTheDocument();
  expect(screen.queryByText('Current instruction')).not.toBeInTheDocument();
  expect(screen.getByText(/not that the model completed/)).toBeInTheDocument();
});

it('uses the persisted state for pause/resume and keeps errors visible without claiming success', async () => {
  const view = render(<NativeScheduleDetails id="task1" onClose={vi.fn()} />, {
    wrapper: TestWrapper,
  });
  mock.pause.mockRejectedValueOnce(new Error('Storage unavailable'));
  fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Storage unavailable');
  expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
  expect(mock.pause).toHaveBeenLastCalledWith(mock.records[0], true);
  mock.records[0].status = 'paused';
  view.rerender(<NativeScheduleDetails id="task1" onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
  await waitFor(() => expect(mock.pause).toHaveBeenLastCalledWith(mock.records[0], false));
  expect(screen.getByRole('textbox', { name: 'Task name' })).toBeEnabled();
});

function TestWrapper({ children }: PropsWithChildren) {
  return (
    <MemoryRouter initialEntries={['/schedules']}>
      <IntlTestWrapper>{children}</IntlTestWrapper>
    </MemoryRouter>
  );
}
function RouteDisplay() {
  const location = useLocation();
  return (
    <output data-testid="route">
      {location.pathname}
      {location.search}
    </output>
  );
}
it.each(['/pair', '/codepro/pair'])(
  'hides the redundant linked-chat entry in %s',
  async (route) => {
    render(
      <MemoryRouter initialEntries={[`${route}?resumeSessionId=chat1`]}>
        <NativeScheduleDetails id="task1" onClose={vi.fn()} />
      </MemoryRouter>,
      { wrapper: IntlTestWrapper }
    );
    await screen.findByRole('textbox', { name: 'Task name' });
    expect(screen.queryByRole('button', { name: 'Linked chat' })).not.toBeInTheDocument();
  }
);
it.each(['/schedules', '/pair?resumeSessionId=other', '/codepro/schedules'])(
  'opens the associated chat from %s and closes the overlay',
  async (route) => {
    const onClose = vi.fn();
    render(
      <MemoryRouter initialEntries={[route]}>
        <NativeScheduleDetails id="task1" onClose={onClose} />
        <RouteDisplay />
      </MemoryRouter>,
      { wrapper: IntlTestWrapper }
    );
    const button = screen.getByRole('button', { name: 'Linked chat' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(screen.getByTestId('route')).toHaveTextContent(
      `${route.startsWith('/codepro') ? '/codepro' : ''}/pair?resumeSessionId=chat1`
    );
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Linked chat' })).not.toBeInTheDocument();
  }
);

it('offers supported time zones instead of free text and saves the selected zone without changing instructions', async () => {
  const user = userEvent.setup();
  render(<NativeScheduleDetails id="task1" onClose={vi.fn()} />, { wrapper: TestWrapper });
  expect(await screen.findByText('Task instructions')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Repeat' }));
  expect(screen.queryByRole('menuitem', { name: 'Cron' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('menuitem', { name: 'Custom' }));
  expect(screen.queryByRole('textbox', { name: 'Time zone' })).not.toBeInTheDocument();
  expect(screen.getByTitle(Intl.DateTimeFormat().resolvedOptions().timeZone)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Time zone' }));
  await user.type(
    screen.getByRole('textbox', { name: 'Search UTC offset, IANA identifier or city' }),
    'Tokyo'
  );
  await user.click(screen.getByRole('option', { name: /Asia\/Tokyo/ }));
  expect(screen.getByRole('button', { name: 'Time zone' })).toHaveTextContent('UTC+09:00');
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(mock.update).toHaveBeenCalled());
  expect(mock.update.mock.calls[0][0]).toMatchObject({
    prompt: 'Current instruction',
    change: { kind: 'daily', daily: { time_zone: 'Asia/Tokyo' } },
  });
});

it('converts interval units to native seconds and prevents sub-minute schedules', async () => {
  const user = userEvent.setup();
  render(<NativeScheduleDetails id="task1" onClose={vi.fn()} />, { wrapper: TestWrapper });
  await user.click(screen.getByRole('button', { name: 'Repeat' }));
  await user.click(screen.getByRole('menuitem', { name: 'Every N seconds' }));
  const input = screen.getByRole('spinbutton', { name: 'Repeat interval' });
  expect(input).toHaveValue(60);
  fireEvent.change(input, { target: { value: '59' } });
  fireEvent.submit(screen.getByRole('button', { name: 'Save changes' }).closest('form')!);
  expect(await screen.findByRole('alert')).toHaveTextContent('at least 60');
  expect(mock.update).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '120' } });
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(mock.update).toHaveBeenCalled());
  expect(mock.update.mock.calls[0][0].change).toEqual({ kind: 'every', every_seconds: 120 });
  await user.click(screen.getByRole('button', { name: 'Repeat' }));
  await user.click(screen.getByRole('menuitem', { name: 'Every N hours' }));
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(mock.update).toHaveBeenCalledTimes(2));
  expect(mock.update.mock.calls[1][0].change).toEqual({ kind: 'every', every_seconds: 3600 });
});

it('selects hours and minutes without saving until the user submits', async () => {
  const { within } = await import('@testing-library/react');
  const user = userEvent.setup();
  render(<NativeScheduleDetails id="task1" onClose={vi.fn()} />, { wrapper: TestWrapper });
  await user.click(screen.getByRole('button', { name: 'Repeat' }));
  await user.click(screen.getByRole('menuitem', { name: 'Custom' }));
  await user.click(screen.getByRole('button', { name: 'Time' }));
  const hours = screen.getByRole('listbox', { name: 'hours' });
  const minutes = screen.getByRole('listbox', { name: 'minutes' });
  await user.click(within(hours).getByRole('option', { name: '17' }));
  await user.click(within(minutes).getByRole('option', { name: '07' }));
  expect(mock.update).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Time' })).toHaveTextContent('17:07');
  await user.keyboard('{ArrowDown}');
  expect(within(minutes).getByRole('option', { name: '08' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('listbox', { name: 'hours' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(mock.update).toHaveBeenCalledOnce());
  expect(mock.update.mock.calls[0][0]).toMatchObject({
    change: { kind: 'daily', daily: { time: '17:08:00' } },
  });
});

it('saves multiple weekly weekdays and monthly dates through native rules', async () => {
  const user = userEvent.setup();
  render(<NativeScheduleDetails id="task1" onClose={vi.fn()} />, { wrapper: TestWrapper });
  await user.click(screen.getByRole('button', { name: 'Repeat' }));
  await user.click(screen.getByRole('menuitem', { name: 'Custom' }));
  await user.click(screen.getByRole('button', { name: 'Frequency' }));
  await user.click(screen.getByRole('menuitem', { name: 'Every week' }));
  await user.click(screen.getByRole('button', { name: 'Wednesday' }));
  await user.click(screen.getByRole('button', { name: 'Friday' }));
  await user.click(screen.getByRole('button', { name: 'Monday' }));
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(mock.update).toHaveBeenCalledOnce());
  expect(mock.update.mock.calls[0][0]).toMatchObject({ change: { kind: 'weekly', weekly: { weekdays: [3, 5] } } });
  await user.click(screen.getByRole('button', { name: 'Frequency' }));
  await user.click(screen.getByRole('menuitem', { name: 'Monthly' }));
  for (const day of [6, 11, 17, 18, 24, 31, 1]) await user.click(screen.getByRole('button', { name: `Day ${day}` }));
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(mock.update).toHaveBeenCalledTimes(2));
  expect(mock.update.mock.calls[1][0]).toMatchObject({ change: { kind: 'cron', cron: { expression: '0 9 6,11,17,18,24,31 * *' } } });
});
