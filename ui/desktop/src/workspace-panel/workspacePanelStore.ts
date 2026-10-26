import type { PanelDocument, PanelFileInfo, PanelScope } from './workspacePanelTypes';
import type { LongTermGoal } from '../acp/goals';
import type { DocumentView } from './dshDocumentRenderer';
export type WorkbenchTab =
  | { id: string; kind: 'goal'; title: string; goal: LongTermGoal; draft: string }
  | {
      id: string;
      kind: 'file';
      title: string;
      document: PanelDocument;
      draft: string;
      preview: boolean;
    }
  | { id: string; kind: 'file-info'; title: string; file: PanelFileInfo; view?: DocumentView }
  | { id: string; kind: 'terminal' | 'browser'; title: string }
  | {
      id: string;
      kind: 'change';
      title: string;
      turnId?: string;
      filePath: string;
      toolCallId?: string;
    }
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
  mediaHidden?: boolean;
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
    s.tabs.some(
      (t) =>
        (t.kind === 'file' && t.draft !== t.document.content) ||
        (t.kind === 'goal' && t.draft !== t.goal.objective)
    )
  );
}
