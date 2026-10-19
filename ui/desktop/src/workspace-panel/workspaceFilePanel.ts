export const OPEN_WORKSPACE_FILE = 'codebuddy:open-workspace-file';
export interface WorkspaceFileTarget {
  sessionId: string;
  filePath: string;
}
export function openWorkspaceFile(target: WorkspaceFileTarget): void {
  window.dispatchEvent(new CustomEvent(OPEN_WORKSPACE_FILE, { detail: target }));
}
