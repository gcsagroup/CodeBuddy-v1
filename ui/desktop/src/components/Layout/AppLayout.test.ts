import { describe, expect, it } from 'vitest';
import {
  getCodeProChatInset,
  getCodeProTaskPanelLayout,
  readCodeProTaskPanelPreferences,
  shouldRestoreNavigationForWorkspace,
  shouldShowCodeProTaskPanel,
} from './AppLayout';

describe('readCodeProTaskPanelPreferences', () => {
  it('restores only valid boolean and bounded numeric preferences', () => {
    const storage = {
      getItem: (key: string) =>
        key.endsWith('.expanded') ? 'false' : key.endsWith('.width') ? '412' : null,
    };

    expect(readCodeProTaskPanelPreferences(storage)).toEqual({ expanded: false, width: 412 });
    expect(
      readCodeProTaskPanelPreferences({
        getItem: (key: string) => (key.endsWith('.expanded') ? 'true' : '360'),
      })
    ).toEqual({ expanded: true, width: 360 });
  });

  it('falls back safely for malformed or unavailable storage', () => {
    expect(
      readCodeProTaskPanelPreferences({
        getItem: () => 'not-a-preference',
      })
    ).toEqual({ expanded: true, width: 560 });
    expect(
      readCodeProTaskPanelPreferences({
        getItem: () => {
          throw new Error('storage denied');
        },
      })
    ).toEqual({ expanded: true, width: 560 });
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

describe('getCodeProTaskPanelLayout', () => {
  it('uses drawer, overlay, and inline modes at the documented breakpoints', () => {
    expect(getCodeProTaskPanelLayout(320)).toBe('drawer');
    expect(getCodeProTaskPanelLayout(799)).toBe('drawer');
    expect(getCodeProTaskPanelLayout(800)).toBe('overlay');
    expect(getCodeProTaskPanelLayout(1199)).toBe('overlay');
    expect(getCodeProTaskPanelLayout(1200)).toBe('inline');
    expect(getCodeProTaskPanelLayout(1440)).toBe('inline');
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
