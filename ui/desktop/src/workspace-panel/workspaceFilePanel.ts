import type { PanelFileMenuChoice } from './workspacePanelTypes';

export const OPEN_WORKSPACE_FILE = 'codebuddy:open-workspace-file';
export interface WorkspaceFileTarget {
  sessionId: string;
  filePath: string;
  action?: PanelFileMenuChoice | 'file-menu';
  menuKind?: 'link' | 'image' | 'video';
}
export function openWorkspaceFile(target: WorkspaceFileTarget): void {
  window.dispatchEvent(new CustomEvent(OPEN_WORKSPACE_FILE, { detail: target }));
}

export const ATTACH_WORKSPACE_IMAGE = 'codebuddy:attach-workspace-image';
export interface WorkspaceImageAttachment {
  sessionId: string;
  name: string;
  dataUrl: string;
}
export const OPEN_WORKSPACE_WEB = 'codebuddy:open-workspace-web';
export interface WorkspaceWebTarget {
  sessionId: string;
  url: string;
}

export function workspaceLinkPath(value: string): string | undefined {
  try {
    if (/^file:/i.test(value)) {
      const url = new URL(value);
      if (url.hostname || url.search || url.hash) return undefined;
      return decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i, '$1');
    }
    if (/^(?:[a-z]:[\\/]|\/(?!\/))/i.test(value)) return decodeURI(value);
    if (!value || /^(?:[\\/]|[a-z][a-z0-9+.-]*:)/i.test(value)) return undefined;
    const relative = new URL(value, 'file:///workspace/');
    if (relative.hostname || relative.search || relative.hash) return undefined;
    const filePath = decodeURIComponent(value);
    if (/^(?:[\\/]|[a-z][a-z0-9+.-]*:)/i.test(filePath)) return undefined;
    // Resolve against the session workspace through the existing main-process
    // path guard, never against the packaged renderer's file:// location.
    return filePath;
  } catch {
    /* Incomplete or malformed Markdown URLs are not file targets. */
  }
  return undefined;
}
