import { describe, expect, it } from 'vitest';
import {
  getCodeProChatInset,
  getCodeProTaskPanelLayout,
  getCodeProPanelWidth,
  CODEPRO_TASK_PANEL_WIDTH_KEY,
  readCodeProTaskPanelPreferences,
  shouldRestoreNavigationForWorkspace,
  shouldShowCodeProTaskPanel,
} from './AppLayout';

describe('readCodeProTaskPanelPreferences', () => {
  it('restores only valid boolean and bounded numeric preferences', () => {
    const storage = {
      getItem: (key: string) =>
        key.endsWith('.expanded') ? 'false' : key === CODEPRO_TASK_PANEL_WIDTH_KEY ? '412' : null,
    };

    expect(readCodeProTaskPanelPreferences(storage)).toEqual({
      expanded: false,
      width: 412,
    });
    expect(
      readCodeProTaskPanelPreferences({
        getItem: (key: string) => (key.endsWith('.expanded') ? 'true' : '340'),
      })
    ).toEqual({ expanded: true, width: 340 });
  });

  it('falls back safely for malformed or unavailable storage', () => {
    expect(
      readCodeProTaskPanelPreferences({
        getItem: () => 'not-a-preference',
      })
    ).toEqual({ expanded: true, width: null });
    expect(
      readCodeProTaskPanelPreferences({
        getItem: () => {
          throw new Error('storage denied');
        },
      })
    ).toEqual({ expanded: true, width: null });
  });
});

describe('getCodeProChatInset', () => {
  it('reserves space for the expanded CodePro task panel', () => {
    expect(getCodeProChatInset(true, true, 340, 'inline')).toBe(340);
  });

  it('uses the full chat width outside inline mode or an expanded task panel', () => {
    expect(getCodeProChatInset(true, false)).toBeUndefined();
    expect(getCodeProChatInset(false, true)).toBeUndefined();
    expect(getCodeProChatInset(true, true, 340, 'overlay')).toBeUndefined();
    expect(getCodeProChatInset(true, true, 340, 'drawer')).toBeUndefined();
  });
});

describe('workspace split geometry', () => {
  it('defaults to one third of the actual work area, with fixed pixel minimums', () => {
    expect(getCodeProPanelWidth(1200, null)).toBe(400);
    expect(getCodeProPanelWidth(960, null)).toBe(340);
    expect(getCodeProPanelWidth(800, null)).toBe(340);
    expect(getCodeProPanelWidth(800, 700)).toBe(480);
    expect(getCodeProPanelWidth(1200, 700)).toBe(700);
  });

  it('uses a single pane when both absolute minimums cannot fit', () => {
    expect(getCodeProTaskPanelLayout(320)).toBe('drawer');
    expect(getCodeProTaskPanelLayout(659)).toBe('drawer');
    expect(getCodeProTaskPanelLayout(660)).toBe('inline');
    expect(getCodeProPanelWidth(600, 400)).toBe(600);
  });
});

describe('shouldRestoreNavigationForWorkspace', () => {
  it('opens the sidebar once when entering CodePro', () => {
    expect(shouldRestoreNavigationForWorkspace(null, 'codepro')).toBe(true);
    expect(shouldRestoreNavigationForWorkspace('code', 'codepro')).toBe(true);
  });

  it('does not fight a manual collapse while already in CodePro', () => {
    expect(shouldRestoreNavigationForWorkspace('codepro', 'codepro')).toBe(false);
    expect(shouldRestoreNavigationForWorkspace('codepro', 'code')).toBe(false);
  });
});

describe('shouldShowCodeProTaskPanel', () => {
  it('restores the task panel on the CodePro pair route without requiring existing task content', () => {
    expect(shouldShowCodeProTaskPanel('codepro', true)).toBe(true);
  });

  it('keeps the task panel off ordinary Code routes', () => {
    expect(shouldShowCodeProTaskPanel('code', true)).toBe(false);
    expect(shouldShowCodeProTaskPanel('codepro', false)).toBe(false);
  });
});
