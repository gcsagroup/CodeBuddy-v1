import { describe, expect, it, vi } from 'vitest';
import {
  createNavigationHandler,
  getWorkspaceModeFromPath,
  withWorkspaceMode,
} from './navigationUtils';

describe('withWorkspaceMode', () => {
  it('keeps Code routes unchanged', () => {
    expect(withWorkspaceMode('/', 'code')).toBe('/');
    expect(withWorkspaceMode('/settings', 'code')).toBe('/settings');
  });

  it('prefixes CodePro routes while preserving the CodePro home path', () => {
    expect(withWorkspaceMode('/', 'codepro')).toBe('/codepro');
    expect(withWorkspaceMode('/settings', 'codepro')).toBe('/codepro/settings');
    expect(withWorkspaceMode('/pair?resumeSessionId=123', 'codepro')).toBe(
      '/codepro/pair?resumeSessionId=123'
    );
    expect(withWorkspaceMode('/configure-providers', 'codepro')).toBe(
      '/codepro/configure-providers'
    );
  });
});

describe('getWorkspaceModeFromPath', () => {
  it('keeps nested shared pages in the workspace that opened them', () => {
    expect(getWorkspaceModeFromPath('/codepro/configure-providers')).toBe('codepro');
    expect(getWorkspaceModeFromPath('/codepro/recipes')).toBe('codepro');
    expect(getWorkspaceModeFromPath('/configure-providers')).toBe('code');
  });
});

describe('createNavigationHandler', () => {
  it('keeps settings, sessions, and toolbox inside CodePro', () => {
    const navigate = vi.fn();
    const setView = createNavigationHandler(navigate, 'codepro');

    setView('settings');
    setView('sessions');
    setView('toolbox');

    expect(navigate).toHaveBeenNthCalledWith(1, '/codepro/settings', { state: undefined });
    expect(navigate).toHaveBeenNthCalledWith(2, '/codepro/sessions', { state: undefined });
    expect(navigate).toHaveBeenNthCalledWith(3, '/codepro/toolbox', { state: undefined });
  });

  it('opens settings over the current route when a location is available', () => {
    const navigate = vi.fn();
    const currentLocation = {
      pathname: '/codepro/pair',
      search: '?resumeSessionId=session-1',
      hash: '',
      state: null,
      key: 'current',
    };
    const setView = createNavigationHandler(navigate, 'codepro', currentLocation);

    setView('settings', { section: 'memory' });

    expect(navigate).toHaveBeenCalledWith('/codepro/settings', {
      state: { section: 'memory', backgroundLocation: currentLocation },
    });
  });
});
