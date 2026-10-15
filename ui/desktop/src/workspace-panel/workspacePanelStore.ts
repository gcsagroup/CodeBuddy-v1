import type { PanelDocument, PanelScope } from './workspacePanelTypes';
export type WorkbenchTab =
  | {
      id: string;
      kind: 'file';
      title: string;
      document: PanelDocument;
      draft: string;
      preview: boolean;
    }
  | { id: string; kind: 'terminal' | 'browser'; title: string }
  | { id: string; kind: 'change'; title: string; turnId: string; filePath: string }
  | {
      id: string;
      kind: 'subagent';
      title: string;
      parentSessionId: string;
      childSessionId: string;
      ancestorSessionIds?: string[];
    };
export interface WorkbenchState {
  tabs: WorkbenchTab[];
  active: string;
}
const sessions = new Map<string, WorkbenchState>();
export const scopeKey = (scope: PanelScope) => JSON.stringify([scope.sessionId, scope.root]);
export function readWorkbench(key: string): WorkbenchState {
  return sessions.get(key) ?? { tabs: [], active: 'start' };
}
export function saveWorkbench(key: string, state: WorkbenchState) {
  sessions.set(key, state);
}
export function hasUnsavedWorkbenchFiles() {
  return [...sessions.values()].some((s) =>
    s.tabs.some((t) => t.kind === 'file' && t.draft !== t.document.content)
  );
}
