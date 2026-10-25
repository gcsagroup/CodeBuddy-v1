import type { ManagedSkill, SourceEntry } from '@aaif/goose-sdk';
import type { ExtensionEntry } from './extensions';

export type ToolboxKind = 'builtin' | 'skill' | 'app' | 'external';
export type ToolboxSource = 'source' | 'app' | 'extension';
export type ToolboxStatus = 'ready' | 'configured' | 'disabled' | 'setup' | 'permission' | 'failed';
export type ToolboxAction = 'inspect' | 'launch' | 'configure' | 'enable' | 'disable';

export interface ToolboxUsage {
  lastUsedAt?: string;
  successCount: number;
  recentResult?: string;
}

export interface ToolboxItem {
  /** UI grouping only; members retain their existing configuration identities. */
  repositoryMembers?: ToolboxItem[];
  id: string;
  kind: ToolboxKind;
  source: ToolboxSource;
  name: string;
  description: string;
  status: ToolboxStatus;
  actions: ToolboxAction[];
  locked?: boolean;
  tools?: string[];
  reference?: { key: string; value: string };
  usage?: ToolboxUsage;
  skillSource?: SourceEntry | ManagedSkill;
  extensionSource?: ExtensionEntry;
}

export interface ToolboxModel {
  capabilities: ToolboxItem[];
  methods: ToolboxItem[];
  apps: ToolboxItem[];
  external: ToolboxItem[];
}
