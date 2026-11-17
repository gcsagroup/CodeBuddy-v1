import { readWorkbench, saveWorkbench, scopeKey } from './workspacePanelStore';
import type { PanelRequest } from './workspacePanelTypes';
export const BROWSER_TAB_EVENT = 'codebuddy:browser-tab';
export async function controlWorkspaceBrowser(
  params: Record<string, unknown>,
  signal?: globalThis.AbortSignal
) {
  signal?.throwIfAborted();
  if (params.action !== 'browser-control' || !params.scope || typeof params.scope !== 'object')
    throw new Error('Invalid browser request');
  const request = params as unknown as Extract<PanelRequest, { action: 'browser-control' }>;
  const key = scopeKey(request.scope);
  const announceTab = (id: string, closed = false) => window.dispatchEvent(
    new CustomEvent(BROWSER_TAB_EVENT, { detail: { scope: request.scope, id, closed } })
  );
  // Show the existing target while the native action runs, including when it fails.
  const knownTarget = request.operation !== 'open' && request.operation !== 'close' && request.id &&
    readWorkbench(key).tabs.some(tab => tab.kind === 'browser' && tab.id === request.id);
  if (knownTarget) announceTab(request.id!);
  let reply;
  try {
    reply = await window.electron.workspacePanel(request);
  } catch (error) {
    // JSON-RPC hides unexpected exception messages. Return the native failure
    // explicitly so the host can report an actionable tool error to the model.
    return { error: { message: error instanceof Error ? error.message : String(error) } };
  }
  const id = reply.id ?? request.id;
  if (id && ['open', 'close'].includes(request.operation)) {
    const current = readWorkbench(key);
    const tab = { id, kind: 'browser' as const, title: reply.browser?.title || reply.browser?.url || 'Browser' };
    saveWorkbench(key, {
      ...current,
      tabs: request.operation === 'close' ? current.tabs.filter(t => t.id !== id)
        : current.tabs.some(t => t.id === id) ? current.tabs.map(t => t.id === id ? tab : t)
        : [...current.tabs, tab],
      active: request.operation !== 'close' ? id : current.active === id ? 'start' : current.active,
    });
  }
  // The real native receipt is returned even if cancellation arrives after input.
  if (id && !knownTarget) announceTab(id, request.operation === 'close');
  return reply.result ?? {};
}
