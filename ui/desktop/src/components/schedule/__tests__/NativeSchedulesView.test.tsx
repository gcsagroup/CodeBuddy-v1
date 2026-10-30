import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import { OPEN_NATIVE_SCHEDULE } from '../scheduleEvents';
import NativeSchedulesView from '../NativeSchedulesView';

const mock = vi.hoisted(() => ({
  navigate: vi.fn(),
  snapshot: {
    records: [] as Record<string, unknown>[],
    status: 'ready',
    error: undefined as string | undefined,
  },
}));
vi.mock('../../../hooks/useNavigation', () => ({ useNavigation: () => mock.navigate }));
vi.mock('../../../acp/nativeSchedules', () => ({
  useNativeSchedules: () => mock.snapshot,
  refreshNativeSchedules: vi.fn(),
}));
beforeEach(() => {
  vi.clearAllMocks();
  mock.snapshot = {
    records: [
      {
        id: 'live',
        title: 'Check progress',
        prompt: 'inspect build',
        kind: 'every',
        everySeconds: 60,
        sessionId: 'chat1',
        status: 'active',
        scheduledAt: '2026-11-01T01:00:00Z',
      },
      {
        id: 'done',
        title: 'One off',
        prompt: 'archived output',
        kind: 'at',
        sessionId: 'chat2',
        status: 'inactive',
        scheduledAt: '2026-10-01T01:00:00Z',
      },
    ],
    status: 'ready',
    error: undefined,
  };
});
it('opens a draft chat without sending, filters catalog rows and opens the shared detail target', () => {
  const open = vi.fn();
  window.addEventListener(OPEN_NATIVE_SCHEDULE, open);
  render(<NativeSchedulesView onClose={vi.fn()} />, { wrapper: IntlTestWrapper });
  fireEvent.click(screen.getByRole('button', { name: /New/ }));
  expect(mock.navigate).toHaveBeenCalledWith(
    'pair',
    expect.objectContaining({
      noAutoSubmit: true,
      draftOnly: true,
      initialMessage: expect.objectContaining({ msg: expect.any(String) }),
    })
  );
  fireEvent.click(screen.getByRole('tab', { name: 'Ended' }));
  expect(screen.queryByRole('button', { name: /Check progress/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'All' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Search automation tasks' }), {
    target: { value: 'build' },
  });
  expect(screen.queryByRole('button', { name: /One off/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Check progress/ }));
  expect((open.mock.calls[0][0] as CustomEvent).detail).toEqual({ id: 'live' });
  window.removeEventListener(OPEN_NATIVE_SCHEDULE, open);
});
it('does not disguise a failed catalog read as an empty successful list', () => {
  mock.snapshot = { records: [], status: 'error', error: 'catalog unavailable' };
  render(<NativeSchedulesView onClose={vi.fn()} />, { wrapper: IntlTestWrapper });
  expect(screen.getByRole('alert')).toHaveTextContent('catalog unavailable');
  expect(screen.queryByText('No automation tasks')).not.toBeInTheDocument();
});

it('filters recurring tasks by native status rather than treating all recurring rules as active', () => {
  const recurring = mock.snapshot.records[0];
  mock.snapshot.records.push(
    { ...recurring, id: 'paused', title: 'Paused recurring', status: 'paused' },
    { ...recurring, id: 'ended-recurring', title: 'Ended recurring', status: 'inactive' },
  );
  render(<NativeSchedulesView onClose={vi.fn()} />, { wrapper: IntlTestWrapper });
  fireEvent.click(screen.getByRole('tab', { name: 'Ended' }));
  expect(screen.getByRole('button', { name: /Ended recurring/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /One off/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Paused recurring/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Check progress/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Paused' }));
  expect(screen.getByRole('button', { name: /Paused recurring/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Ended recurring/ })).not.toBeInTheDocument();
});
