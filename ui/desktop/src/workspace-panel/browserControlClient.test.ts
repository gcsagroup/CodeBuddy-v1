import { it, expect, vi } from 'vitest';
import { controlWorkspaceBrowser } from './browserControlClient';
import { readWorkbench, scopeKey } from './workspacePanelStore';

it('preserves native failure details without creating a phantom browser tab', async () => {
  window.electron.workspacePanel = vi.fn().mockRejectedValue(new Error('ENOENT: missing.html'));
  const scope = { sessionId: 'missing-browser-test', root: '/workspace' };
  expect(await controlWorkspaceBrowser({ action: 'browser-control', scope, operation: 'open', htmlPath: 'missing.html' }))
    .toEqual({ error: { message: 'ENOENT: missing.html' } });
  expect(readWorkbench(scopeKey(scope)).tabs).toEqual([]);
});

it('retains a native browser opened while its conversation panel is unmounted', async () => {
  window.electron.workspacePanel = vi.fn();
  const scope = { sessionId: 'background-browser-test', root: '/workspace' };
  vi.mocked(window.electron.workspacePanel).mockResolvedValueOnce({
    id: 'background-tab',
    result: { id: 'background-tab' },
  });
  await controlWorkspaceBrowser({
    action: 'browser-control',
    scope,
    operation: 'open',
    url: 'http://localhost',
  });
  expect(readWorkbench(scopeKey(scope))).toMatchObject({
    active: 'background-tab',
    tabs: [{ id: 'background-tab', kind: 'browser' }],
  });
  vi.mocked(window.electron.workspacePanel).mockResolvedValueOnce({ result: { closed: true } });
  await controlWorkspaceBrowser({
    action: 'browser-control',
    scope,
    operation: 'close',
    id: 'background-tab',
  });
  expect(readWorkbench(scopeKey(scope))).toEqual({ active: 'start', tabs: [] });
});
