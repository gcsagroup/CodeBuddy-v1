import { describe, expect, it } from 'vitest';
import { shouldUpdateSessionWorkingDir } from './sessionWorkspace';

describe('shouldUpdateSessionWorkingDir', () => {
  it('does not write when a CodePro path is only a casing or separator variant', () => {
    expect(
      shouldUpdateSessionWorkingDir({
        isCodePro: true,
        currentWorkingDir: 'D:\\CodePro\\Ledger',
        nextWorkingDir: 'd:/codepro/ledger/',
      })
    ).toBe(false);
  });

  it('rejects changing an existing CodePro session to a different directory', () => {
    expect(() =>
      shouldUpdateSessionWorkingDir({
        isCodePro: true,
        currentWorkingDir: 'D:\\CodePro\\Ledger',
        nextWorkingDir: 'E:\\Other\\Project',
      })
    ).toThrow('Start a new CodePro session');
  });

  it('keeps ordinary Code sessions free to change directory', () => {
    expect(
      shouldUpdateSessionWorkingDir({
        isCodePro: false,
        currentWorkingDir: '/tmp/one',
        nextWorkingDir: '/tmp/two',
      })
    ).toBe(true);
  });
});
