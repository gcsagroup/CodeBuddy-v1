import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { getSessionGoal, type LongTermGoal } from '../acp/goals';
import { IntlTestWrapper } from '../i18n/test-utils';
import { ComposerGoalBar } from './ComposerGoalBar';

vi.mock('../acp/goals', () => ({ getSessionGoal: vi.fn() }));
const goal: LongTermGoal = {
  id: 'g',
  revision: 2,
  objective: 'Build the calendar',
  phase: 'paused',
  activation: 'disarmed',
  roundsStarted: 1,
  maxGoalRounds: 256,
};
beforeEach(() => {
  vi.mocked(getSessionGoal).mockReset();
});
const props = () => ({
  sessionId: 's',
  busy: false,
  refreshKey: 0,
  onCommand: vi.fn().mockResolvedValue(undefined),
  onEdit: vi.fn(),
});

it('keeps the composer clear when no unfinished goal exists', async () => {
  vi.mocked(getSessionGoal).mockResolvedValue(null);
  const p = props();
  const view = render(<ComposerGoalBar {...p} />, { wrapper: IntlTestWrapper });
  await waitFor(() => expect(getSessionGoal).toHaveBeenCalledWith('s'));
  expect(view.container).toBeEmptyDOMElement();
  vi.mocked(getSessionGoal).mockResolvedValue({ ...goal, phase: 'complete' });
  view.rerender(<ComposerGoalBar {...p} refreshKey={1} />);
  await waitFor(() => expect(getSessionGoal).toHaveBeenCalledTimes(2));
  expect(view.container).toBeEmptyDOMElement();
});

it('offers resume, edit and clear using the existing composer commands', async () => {
  vi.mocked(getSessionGoal).mockResolvedValue(goal);
  const p = props();
  render(<ComposerGoalBar {...p} />, { wrapper: IntlTestWrapper });
  fireEvent.click(await screen.findByRole('button', { name: 'Resume goal' }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit goal' }));
  fireEvent.click(screen.getByRole('button', { name: 'Clear goal; keep conversation and files' }));
  expect(p.onCommand.mock.calls).toEqual([['/goal resume'], ['/goal clear']]);
  expect(p.onEdit).toHaveBeenCalledWith(goal.objective);
});

it('keeps pause available during execution and prevents exhausted resumes', async () => {
  vi.mocked(getSessionGoal).mockResolvedValue({ ...goal, phase: 'active', activation: 'armed' });
  const p = props();
  const view = render(<ComposerGoalBar {...p} busy />, { wrapper: IntlTestWrapper });
  fireEvent.click(await screen.findByRole('button', { name: 'Pause goal' }));
  expect(p.onCommand).toHaveBeenCalledWith('/goal pause');
  vi.mocked(getSessionGoal).mockResolvedValue({ ...goal, roundsStarted: 256 });
  view.rerender(<ComposerGoalBar {...p} refreshKey={1} />);
  expect(await screen.findByRole('button', { name: 'Resume goal' })).toBeDisabled();
});

it('does not operate on stale state after a read failure or a session switch', async () => {
  vi.mocked(getSessionGoal).mockResolvedValue(goal);
  const p = props();
  const view = render(<ComposerGoalBar {...p} />, { wrapper: IntlTestWrapper });
  await screen.findByRole('button', { name: 'Edit goal' });
  vi.mocked(getSessionGoal).mockRejectedValue(new Error('offline'));
  view.rerender(<ComposerGoalBar {...p} refreshKey={1} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Edit goal' })).toBeDisabled());
  fireEvent.click(screen.getByRole('button', { name: 'View goal details' }));
  expect(p.onEdit).toHaveBeenCalledWith(goal.objective);
  view.rerender(<ComposerGoalBar {...p} sessionId="other" />);
  expect(view.container).toBeEmptyDOMElement();
});
