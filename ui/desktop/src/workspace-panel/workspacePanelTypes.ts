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
export interface PanelBrowserState {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  back: boolean;
  forward: boolean;
  error?: string;
}
export type PanelRequest = { scope: PanelScope } & (
  | { action: 'list'; path: string }
  | { action: 'search'; query: string }
  | { action: 'read'; path: string }
  | { action: 'inspect'; path: string }
  | { action: 'open-external'; path: string }
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
  entries?: PanelEntry[];
  truncated?: boolean;
  document?: PanelDocument;
  file?: PanelFileInfo;
  id?: string;
  data?: string;
  offset?: number;
  reset?: boolean;
  exited?: boolean;
  browser?: PanelBrowserState;
}
