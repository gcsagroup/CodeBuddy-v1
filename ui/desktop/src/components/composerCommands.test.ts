import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createIntl } from 'react-intl';
import {
  changeSessionGoal,
  getSessionGoal,
  pauseSessionGoal,
  setSessionPlanMode,
} from '../acp/goals';
import {
  composerCommandItems,
  parseComposerCommand,
  prepareComposerCommand,
} from './composerCommands';

vi.mock('../acp/goals', () => ({
  getSessionGoal: vi.fn(),
  pauseSessionGoal: vi.fn(),
  setSessionPlanMode: vi.fn(),
  changeSessionGoal: vi.fn(),
}));
const intl = createIntl({ locale: 'en', messages: {} });
const input = (msg: string) => ({ msg, images: [] });
const goal = {
  id: 'g',
  revision: 9,
  phase: 'paused' as const,
  activation: 'disarmed' as const,
  objective: 'Ship',
  roundsStarted: 2,
  maxGoalRounds: 20,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSessionGoal).mockResolvedValue(goal);
});
describe('composer slash commands', () => {
  it('edits and clears the current native goal without sending a model prompt', async () => {
    const edited = await prepareComposerCommand(
      input('/goal edit Ship a calendar'),
      's',
      true,
      intl
    );
    expect(edited.input).toBeUndefined();
    expect(changeSessionGoal).toHaveBeenCalledWith('s', goal, 'edit', 'Ship a calendar');
    const cleared = await prepareComposerCommand(input('/goal clear'), 's', true, intl);
    expect(cleared.input).toBeUndefined();
    expect(changeSessionGoal).toHaveBeenCalledWith('s', goal, 'clear');
  });
  it('does not interpret ordinary prose, unknown commands or a path as controls', async () => {
    for (const text of ['Please pause my goal', '/goals', '/plan/file', 'Explain /plan']) {
      expect(parseComposerCommand(text)).toBeNull();
      expect(await prepareComposerCommand(input(text), 's', false, intl)).toEqual({
        input: input(text),
      });
    }
  });
  it('creates a structured goal in a fresh conversation and preserves attachments', async () => {
    const request = {
      msg: '/goal Build and test pause/resume',
      images: [{ data: 'abc', mimeType: 'image/png' }],
    };
    expect(await prepareComposerCommand(request, null, false, intl)).toEqual({
      input: {
        ...request,
        msg: 'Build and test pause/resume',
        goalRequest: {
          action: 'create',
          objective: 'Build and test pause/resume',
        },
      },
    });
  });
  it('pauses during an active model turn using the latest native revision', async () => {
    await prepareComposerCommand(input('/goal pause'), 's', true, intl);
    expect(pauseSessionGoal).toHaveBeenCalledWith('s', goal);
  });
  it('surfaces a failed pause instead of reporting success', async () => {
    vi.mocked(pauseSessionGoal).mockRejectedValueOnce(new Error('stale'));
    await expect(prepareComposerCommand(input('/goal pause'), 's', true, intl)).rejects.toThrow(
      'stale'
    );
  });
  it('resumes through the normal prompt and rejects duplicate busy or exhausted runs', async () => {
    expect(
      (await prepareComposerCommand(input('/goal resume'), 's', false, intl)).input?.goalRequest
    ).toEqual({ action: 'resume', goalId: 'g', revision: 9 });
    expect(
      (await prepareComposerCommand(input('/goal resume'), 's', true, intl)).input
    ).toBeUndefined();
    vi.mocked(getSessionGoal).mockResolvedValue({ ...goal, roundsStarted: 20 });
    expect(
      (await prepareComposerCommand(input('/goal resume'), 's', false, intl)).input
    ).toBeUndefined();
  });
  it('starts a planning task without changing the tool approval setting', async () => {
    expect(
      await prepareComposerCommand(input('/plan Build a calendar'), null, false, intl)
    ).toEqual({ input: { msg: 'Build a calendar', images: [], planMode: true } });
    vi.mocked(setSessionPlanMode).mockResolvedValue({ active: false });
    await prepareComposerCommand(input('/plan off'), 's', false, intl);
    expect(setSessionPlanMode).toHaveBeenCalledWith('s', false);
  });
  it('exposes discoverable descriptions and keeps bare commands out of model requests', async () => {
    expect(composerCommandItems(intl).map((item) => item.relativePath)).toEqual([
      'file',
      'agent',
      'goal',
      'plan',
      'compact',
      'permission',
      'model',
      'export',
    ]);
    expect((await prepareComposerCommand(input('/goal'), null, false, intl)).notice).toContain(
      '/goal'
    );
    expect((await prepareComposerCommand(input('/plan'), null, false, intl)).notice).toContain(
      '/plan'
    );
    expect(
      (await prepareComposerCommand(input('/goal status'), 's', false, intl)).notice
    ).toContain('Ship');
  });
});
