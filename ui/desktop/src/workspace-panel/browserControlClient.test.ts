import { it, expect, vi } from 'vitest';
import { BROWSER_TAB_EVENT, controlWorkspaceBrowser } from './browserControlClient';
import { readWorkbench, saveWorkbench, scopeKey } from './workspacePanelStore';

it('keeps a reused automation tab in place with its new title and leaves manual tabs alone', async () => {
  const scope = { sessionId: 'repeat-open', root: '/site' };
  const key = scopeKey(scope);
  const manual = { kind: 'browser' as const, id: 'manual', title: 'Notes' };
  saveWorkbench(key, { active: 'manual', filesOpen: true, tabs: [
    { id: 'agent', kind: 'browser', title: 'First build' }, manual,
  ] });
  window.electron.workspacePanel = vi.fn().mockResolvedValue({
    id: 'agent', browser: { title: 'New build' }, result: { id: 'agent' },
  });
  await controlWorkspaceBrowser({ action: 'browser-control', scope, operation: 'open', htmlPath: 'index.html', reuseAutomationTab: true });
  expect(readWorkbench(key)).toEqual({ active: 'agent', filesOpen: true, tabs: [
    { id: 'agent', kind: 'browser', title: 'New build' }, manual,
  ] });
});

it('reveals the intended tab before an action settles and does not reselect it afterwards', async () => {
  const scope = { sessionId: 'slow-browser-test', root: '/workspace' };
  const native = vi.fn().mockResolvedValueOnce({ id: 'target', result: {} });
  window.electron.workspacePanel = native;
  await controlWorkspaceBrowser({ action: 'browser-control', scope, operation: 'open', url: 'http://localhost' });
  let finish!: () => void;
  native.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ result: {} }); }));
  const selected = vi.fn();
  window.addEventListener(BROWSER_TAB_EVENT, selected);
  try {
    const pending = controlWorkspaceBrowser({ action: 'browser-control', scope, operation: 'observe', id: 'target' });
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({ detail: { scope, id: 'target', closed: false } }));
    finish();
    await pending;
    expect(selected).toHaveBeenCalledTimes(1);
  } finally { window.removeEventListener(BROWSER_TAB_EVENT, selected); }
});

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
