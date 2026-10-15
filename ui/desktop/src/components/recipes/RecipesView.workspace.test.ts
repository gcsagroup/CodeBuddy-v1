import { describe, expect, it, vi } from 'vitest';
import {
  createRecipeSessionForWorkspace,
  getRecipeNewWindowOptions,
  getRecipeWorkspaceMode,
  routeCodeProRecipeToWorkspaceHub,
} from './RecipesView';

describe('getRecipeWorkspaceMode', () => {
  it('creates CodePro recipe sessions from the CodePro recipe page', () => {
    expect(getRecipeWorkspaceMode('/codepro/recipes')).toBe('codepro');
  });

  it('keeps ordinary recipe sessions in Code', () => {
    expect(getRecipeWorkspaceMode('/recipes')).toBe('code');
  });
});

describe('createRecipeSessionForWorkspace', () => {
  it('fails closed before create, host cwd, or folder selection for CodePro', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'recipe-session' });
    const chooseOrdinary = vi.fn();
    const getExplicitDir = vi.fn(() => 'D:\\explicit-project');
    const getHostDir = vi.fn(() => 'D:\\host-process');
    const dependencies = { create, getExplicitDir, getHostDir, chooseOrdinary };

    await expect(
      createRecipeSessionForWorkspace('recipe-1', 'codepro', dependencies)
    ).rejects.toThrow('CodePro recipes require Project workspace confirmation');

    expect(chooseOrdinary).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(getExplicitDir).not.toHaveBeenCalled();
    expect(getHostDir).not.toHaveBeenCalled();
  });

  it('preserves ordinary recipe folder selection and session creation', async () => {
    const session = { id: 'recipe-session' };
    const create = vi.fn().mockResolvedValue(session);
    const chooseOrdinary = vi.fn(async (_current, operation) => ({
      workingDir: 'D:\\explicit-project',
      value: await operation('D:\\explicit-project'),
    }));
    const recordSuccess = vi.fn().mockResolvedValue(true);

    await expect(
      createRecipeSessionForWorkspace('recipe-1', 'code', {
        create,
        getExplicitDir: () => 'D:\\explicit-project',
        chooseOrdinary,
        recordSuccess,
      })
    ).resolves.toBe(session);
    expect(create).toHaveBeenCalledWith('D:\\explicit-project', {
      recipeId: 'recipe-1',
      workspaceMode: 'code',
    });
    expect(recordSuccess).toHaveBeenCalledWith({
      eventId: 'common-task:recipe-session',
      kind: 'common_task',
      capabilityId: 'recipe-1',
      recentResult: 'session started',
      reference: 'common-task:recipe-1',
    });
  });
});

describe('routeCodeProRecipeToWorkspaceHub', () => {
  it('routes same-window CodePro recipes into Pair without creating a session', () => {
    const setView = vi.fn();

    expect(routeCodeProRecipeToWorkspaceHub('recipe-1', 'codepro', setView)).toBe(true);
    expect(setView).toHaveBeenCalledOnce();
    expect(setView).toHaveBeenCalledWith('pair', { recipeId: 'recipe-1' });
  });

  it('leaves ordinary recipes on their existing creation path', () => {
    const setView = vi.fn();

    expect(routeCodeProRecipeToWorkspaceHub('recipe-1', 'code', setView)).toBe(false);
    expect(setView).not.toHaveBeenCalled();
  });
});

describe('getRecipeNewWindowOptions', () => {
  it('lets CodePro recipe windows enter App and Hub without an unbound binding', () => {
    expect(getRecipeNewWindowOptions('recipe-1', 'codepro', 'D:\\recent-project')).toEqual({
      recipeId: 'recipe-1',
      viewType: 'codepro-pair',
      workspaceMode: 'codepro',
    });
  });

  it('keeps the explicit directory for ordinary recipe windows', () => {
    expect(getRecipeNewWindowOptions('recipe-1', 'code', 'D:\\explicit-project')).toEqual({
      recipeId: 'recipe-1',
      viewType: 'pair',
      dir: 'D:\\explicit-project',
      workspaceMode: 'code',
    });
  });
});
