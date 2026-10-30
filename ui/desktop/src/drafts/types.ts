import type { DroppedFile } from '../hooks/useFileDrop';

export type NewTaskDraftKey = 'code' | 'codepro';
export type DraftImage = { id: string; dataUrl: string; isLoading: boolean; error?: string };
export type NewTaskDraft = {
  permissionPreset?: 'read-only' | 'workspace-write' | 'danger-full-access' | null;
  text?: string;
  workingDir?: string;
  images?: DraftImage[];
  files?: DroppedFile[];
};
export type DraftRequest =
  | { action: 'read' }
  | { action: 'update'; key: NewTaskDraftKey; patch: NewTaskDraft }
  | { action: 'clear'; key: NewTaskDraftKey };
export type DraftSnapshot = Partial<Record<NewTaskDraftKey, NewTaskDraft>>;
