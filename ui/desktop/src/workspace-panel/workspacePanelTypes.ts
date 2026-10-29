import type { BrowserControlInput } from './browserControl';
export interface PanelScope {
  sessionId: string;
  root: string;
}
export interface PanelEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file' | 'link';
}
export interface PanelDocument {
  path: string;
  content: string;
  version: string;
  image?: string;
  media?: PanelMedia;
  binary?: boolean;
}
export interface PanelMedia {
  kind: 'image' | 'video';
  mimeType: string;
  url: string;
}
export interface PanelFileInfo {
  path: string;
  size: number;
  openExternally: boolean;
  media?: PanelMedia;
}
export interface PanelDocumentPreview {
  kind: 'pdf' | 'excel';
  data: Uint8Array;
  missingFonts: readonly string[];
}
export interface PanelBrowserState {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  back: boolean;
  forward: boolean;
  error?: string;
}
export type PanelFileAction =
  | 'open-external'
  | 'reveal'
  | 'copy-path'
  | 'copy-image'
  | 'copy-text'
  | 'save-as';
export type PanelFileMenuChoice = PanelFileAction | 'preview' | 'image-tab' | 'add-to-chat';
export type PanelFileMenuLabels = Record<PanelFileMenuChoice, string> & { editor?: string };
export type PanelTabAction = 'close' | 'close-others' | 'close-right';
export interface PanelTabMenuRequest {
  scope?: PanelScope;
  path?: string;
  labels: PanelFileMenuLabels;
  tabs: { labels: Record<PanelTabAction, string>; others: boolean; right: boolean };
}
export type WebLinkMenuChoice = 'preview' | 'open-external' | 'copy-link' | 'save-link';
export interface WebLinkMenuRequest {
  url: string;
  allowPreview: boolean;
  labels: Record<WebLinkMenuChoice, string>;
}
export type PanelRequest = { scope: PanelScope } & (
  | ({ action: 'browser-control' } & BrowserControlInput)
  | { action: 'list'; path: string }
  | { action: 'search'; query: string }
  | { action: 'read'; path: string }
  | { action: 'read-reference'; path: string }
  | { action: 'inspect'; path: string }
  | { action: 'document-preview'; path: string; requestId: string }
  | { action: 'document-preview-cancel'; requestId: string }
  | { action: 'open-external'; path: string }
  | { action: 'reveal' | 'copy-path' | 'copy-image' | 'copy-text' | 'save-as'; path: string }
  | {
      action: 'file-menu';
      path: string;
      kind: 'link' | 'image' | 'video';
      labels: PanelFileMenuLabels;
      tabs?: PanelTabMenuRequest['tabs'];
    }
  | { action: 'attach-image'; path: string }
  | { action: 'save'; path: string; content: string; version: string }
  | { action: 'terminal-create' }
  | { action: 'terminal-read'; id: string; offset: number }
  | { action: 'terminal-input'; id: string; data: string }
  | { action: 'terminal-resize'; id: string; cols: number; rows: number }
  | { action: 'terminal-close'; id: string }
  | { action: 'browser-create' }
  | { action: 'browser-state'; id: string }
  | { action: 'browser-navigate'; id: string; url: string }
  | { action: 'browser-command'; id: string; command: 'back' | 'forward' | 'reload' | 'stop' }
  | {
      action: 'browser-bounds';
      id: string;
      bounds: { x: number; y: number; width: number; height: number } | null;
    }
  | { action: 'browser-close'; id: string }
);
export interface PanelReply {
  reference?: { path: string; content: string };
  fileAction?: PanelFileMenuChoice | null;
  tabAction?: PanelTabAction;
  attachment?: { name: string; dataUrl: string };
  result?: Record<string, unknown>;
  entries?: PanelEntry[];
  truncated?: boolean;
  document?: PanelDocument;
  file?: PanelFileInfo;
  documentPreview?: PanelDocumentPreview;
  id?: string;
  data?: string;
  offset?: number;
  reset?: boolean;
  exited?: boolean;
  browser?: PanelBrowserState;
}
