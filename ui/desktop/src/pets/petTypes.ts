export const petStates = [
  'idle',
  'wave',
  'jump',
  'working',
  'waiting',
  'failed',
  'review',
  'look',
] as const;
export type PetAnimation = (typeof petStates)[number];
export type PetTaskState = 'idle' | 'working' | 'completed' | 'blocked' | 'input';
export interface PetManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  image: 'sprites.png';
  columns: 6;
  rows: 8;
  cellWidth: 192;
  cellHeight: 208;
  fps: number;
}
export interface PetAsset extends PetManifest {
  imageUrl: string;
  hash: string;
  builtin: boolean;
}
export interface PetPreferences {
  visible: boolean;
  selectedId: string;
  size: number;
  reducedMotion: boolean;
  position?: { x: number; y: number };
}
export interface PetTask {
  sessionId: string;
  title: string;
  state: PetTaskState;
  terminalId?: string;
  inputRequest?: { kind: 'question' | 'permission' | 'workspace'; summary?: string;
    permission?: { requestId: string; token: string; choices: Array<{ action: import('../types/permissions').Permission; label: string }>; details: string } };
  activity?: {
    kind: 'waiting' | 'thinking' | 'responding' | 'tool' | 'compacting' | 'starting' | 'stopping';
    toolName?: string;
    stage?: string;
  };
}
export interface PetSnapshot {
  preferences: PetPreferences;
  pets: PetAsset[];
  errors: string[];
  creationDirectory: string;
  task: PetTask | null;
  tasks?: PetTask[];
}
export interface PetRequest {
  action:
    | 'get'
    | 'refresh'
    | 'configure'
    | 'create'
    | 'open-task'
    | 'pause-task'
    | 'drag-start'
    | 'drag-end'
    | 'compose'
    | 'context-menu'
    | 'send-message'
    | 'resolve-permission';
  permission?: { requestId: string; token: string; action: import('../types/permissions').Permission };
  preferences?: Partial<Pick<PetPreferences, 'visible' | 'selectedId' | 'size' | 'reducedMotion'>>;
  sessionId?: string;
  composing?: boolean;
  pointer?: { x: number; y: number };
  message?: string;
  images?: import('../types/message').ImageData[];
}
