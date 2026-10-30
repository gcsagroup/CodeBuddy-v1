import type { PanelFileMenuChoice } from './workspacePanelTypes';

export const OPEN_WORKSPACE_FILE = 'codebuddy:open-workspace-file';
export interface WorkspaceFileTarget {
  sessionId: string;
  filePath: string;
  line?: number;
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
    value = value.replace(/#L[1-9]\d*(?:-L?[1-9]\d*)?$|:[1-9]\d*(?::[1-9]\d*)?$/, '');
    if (/^file:/i.test(value)) {
      const url = new URL(value);
      if (url.hostname || url.search || url.hash) return undefined;
      return decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i, '$1');
    }
    // Markdown encodes Windows backslashes as %5C before URL transformation.
    const decoded = decodeURI(value);
    if (/^(?:[a-z]:[\\/]|\/(?!\/))/i.test(decoded)) return decoded;
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

export function workspaceLinkLine(value: string): number | undefined {
  const match = /#L([1-9]\d*)(?:-L?[1-9]\d*)?$|:([1-9]\d*)(?::[1-9]\d*)?$/.exec(value);
  const line = match && Number(match[1] ?? match[2]);
  return line && Number.isSafeInteger(line) ? line : undefined;
}
