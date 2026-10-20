export const OPEN_WORKSPACE_FILE = 'codebuddy:open-workspace-file';
export interface WorkspaceFileTarget {
  sessionId: string;
  filePath: string;
}
export function openWorkspaceFile(target: WorkspaceFileTarget): void {
  window.dispatchEvent(new CustomEvent(OPEN_WORKSPACE_FILE, { detail: target }));
}

export function workspaceLinkPath(value: string): string | undefined {
  try {
    if (/^file:/i.test(value)) {
      const url = new URL(value);
      if (url.hostname || url.search || url.hash) return undefined;
      return decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i, '$1');
    }
    if (/^(?:[a-z]:[\\/]|\/(?!\/))/i.test(value)) return decodeURI(value);
  } catch {
    /* Incomplete or malformed Markdown URLs are not file targets. */
  }
  return undefined;
}
