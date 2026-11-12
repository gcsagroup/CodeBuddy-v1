import { expect, it, vi } from 'vitest';
import { TaskWakelock } from './taskWakelock';

it('holds one system request only while enabled and working, including preference changes mid-task', () => {
  const blocker = { start: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(2), stop: vi.fn() };
  const lock = new TaskWakelock(blocker);
  lock.setWorking(true);
  expect(blocker.start).not.toHaveBeenCalled();
  lock.setEnabled(true);
  lock.setWorking(true);
  expect(blocker.start.mock.calls).toEqual([['prevent-app-suspension']]);
  lock.setEnabled(false);
  expect(blocker.stop).toHaveBeenCalledWith(0);
  lock.setEnabled(true);
  lock.setWorking(false);
  lock.setWorking(false);
  expect(blocker.stop.mock.calls).toEqual([[0], [2]]);
});
