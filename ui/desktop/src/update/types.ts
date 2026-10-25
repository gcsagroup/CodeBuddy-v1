export type UpdateChannel = 'stable' | 'preview';
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error';
export type UpdateState = {
  phase: UpdatePhase;
  currentVersion: string;
  channel: UpdateChannel;
  version?: string;
  notes?: string;
  percent?: number;
  error?: string;
};
export type UpdateArtifact = {
  platform: 'win32' | 'darwin';
  arch: 'x64' | 'arm64';
  name: string;
  size: number;
  sha256: string;
};
export type UpdateManifest = {
  schemaVersion: 1;
  version: string;
  artifacts: UpdateArtifact[];
};
