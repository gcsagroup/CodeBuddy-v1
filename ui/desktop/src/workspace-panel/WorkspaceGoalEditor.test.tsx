import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { changeSessionGoal, getSessionGoal, type LongTermGoal } from '../acp/goals';
import { IntlTestWrapper } from '../i18n/test-utils';
import { WorkspaceGoalEditor } from './WorkspaceGoalEditor';
vi.mock('../acp/goals', () => ({ changeSessionGoal: vi.fn(), getSessionGoal: vi.fn() }));
const original: LongTermGoal = {
  id: 'g',
  revision: 4,
  phase: 'paused',
  activation: 'disarmed',
  objective: 'Original goal',
  roundsStarted: 1,
  maxGoalRounds: 256,
};
beforeEach(() => {
  vi.resetAllMocks();
});
function Editor() {
  const [goal, setGoal] = useState(original),
    [draft, setDraft] = useState(original.objective);
  return (
    <WorkspaceGoalEditor
      sessionId="s"
      goal={goal}
      draft={draft}
      onDraftChange={setDraft}
      onGoalChange={(next, submitted) => {
        setGoal(next);
        setDraft((current) =>
          submitted !== undefined && current === submitted ? next.objective : current
        );
      }}
    />
  );
}
it('saves through the native revision, supports undo, and never resumes the goal', async () => {
  vi.mocked(changeSessionGoal).mockResolvedValue({
    ...original,
    revision: 5,
    objective: 'Revised goal',
  });
  render(<Editor />, { wrapper: IntlTestWrapper });
  const input = screen.getByRole('textbox', { name: 'Edit goal' });
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  fireEvent.change(input, { target: { value: 'Discard this' } });
  fireEvent.click(screen.getByRole('button', { name: 'Undo changes' }));
  expect(input).toHaveValue(original.objective);
  fireEvent.change(input, { target: { value: 'Revised goal' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
  expect(changeSessionGoal).toHaveBeenCalledExactlyOnceWith('s', original, 'edit', 'Revised goal');
});
it('keeps a failed save draft and reads the latest revision without overwriting it', async () => {
  vi.mocked(changeSessionGoal).mockRejectedValue(new Error('Stale revision'));
  vi.mocked(getSessionGoal).mockResolvedValue({
    ...original,
    revision: 6,
    objective: 'External change',
  });
  render(<Editor />, { wrapper: IntlTestWrapper });
  const input = screen.getByRole('textbox', { name: 'Edit goal' });
  fireEvent.change(input, { target: { value: 'Keep this draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Read latest goal' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(input).toHaveValue('Keep this draft');
  fireEvent.click(screen.getByRole('button', { name: 'Undo changes' }));
  expect(input).toHaveValue('External change');
});
it('preserves typing that arrives while a save is pending', async () => {
  let resolve!: (goal: LongTermGoal) => void;
  vi.mocked(changeSessionGoal).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    })
  );
  render(<Editor />, { wrapper: IntlTestWrapper });
  const input = screen.getByRole('textbox', { name: 'Edit goal' });
  fireEvent.change(input, { target: { value: 'First edit' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  fireEvent.change(input, { target: { value: 'Newer edit' } });
  resolve({ ...original, revision: 5, objective: 'First edit' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
  expect(input).toHaveValue('Newer edit');
});
