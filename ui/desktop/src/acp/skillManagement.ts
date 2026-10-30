import type {
  ManagedSkill,
  SkillDestinationRoot,
  SkillManagementOperation,
  SkillRecoveryEntry,
} from '@aaif/goose-sdk';
import { getAcpClient } from './acpConnection';

export type { ManagedSkill, SkillDestinationRoot, SkillManagementOperation, SkillRecoveryEntry };

export interface SkillManagementPreview {
  previewToken: string;
  expiresAt: string;
  operation: string;
  target: string;
  requiresConfirmation: boolean;
  hasConflict: boolean;
  files: string[];
  diff?: string;
}

export async function listManagedSkills(projectDir?: string): Promise<{
  skills: ManagedSkill[];
  destinationRoots: SkillDestinationRoot[];
  diagnostics?: string[];
}> {
  const client = await getAcpClient();
  return client.goose.skillsManageList_unstable({ projectDir });
}

export async function previewSkillChange(
  change: SkillManagementOperation,
  projectDir?: string
): Promise<SkillManagementPreview> {
  const client = await getAcpClient();
  const response = await client.goose.skillsManagePreview_unstable({
    projectDir,
    change,
  });
  return {
    ...response,
    files: response.files ?? [],
    diff: response.diff ?? undefined,
  };
}

export async function previewSkillDownload(
  url: string,
  destination: { rootKind: SkillDestinationRoot['rootKind']; rootId: string; name: string },
  projectDir?: string
): Promise<SkillManagementPreview> {
  const client = await getAcpClient();
  const response = await client.goose.skillsManageDownloadPreview_unstable({
    projectDir,
    destination,
    url,
  });
  return {
    ...response,
    files: response.files ?? [],
    diff: response.diff ?? undefined,
  };
}

export async function applySkillChange(previewToken: string): Promise<{
  skill?: ManagedSkill;
  recoveryRef?: string;
}> {
  const client = await getAcpClient();
  const response = await client.goose.skillsManageApply_unstable({ previewToken });
  return {
    skill: response.skill ?? undefined,
    recoveryRef: response.recoveryRef ?? undefined,
  };
}

export async function listSkillRecoveries(projectDir?: string): Promise<SkillRecoveryEntry[]> {
  const client = await getAcpClient();
  const response = await client.goose.skillsManageRecoveryList_unstable({
    projectDir,
  });
  return response.entries;
}

const REASONS = [
  'project_not_found',
  'source_not_found',
  'source_scope_mismatch',
  'read_only',
  'stale_source',
  'invalid_preview',
  'expired_preview',
  'confirmation_required',
  'confirmation_cancelled',
  'invalid_confirmation',
  'stale_import_source',
  'filesystem_identity_changed',
  'invalid_frontmatter',
  'missing_frontmatter',
  'missing_name',
  'name_mismatch',
  'import_not_found',
  'unsupported_import',
  'linked_path_rejected',
  'destination_conflict',
  'restore_conflict',
  'recovery_not_found',
  'unsafe_download_url',
  'private_network_rejected',
  'unsupported_download_url',
  'download_file_limit',
  'download_size_limit',
  'download_timeout',
  'download_failed',
  'download_http_error',
  'invalid_skill_document',
  'missing_skill_document',
  'download_stage_failed',
  'invalid_github_commit',
  'unsupported_github_entry',
  'linked_download_entry',
  'download_path_escape',
  'invalid_download_response',
  'unexpected_download_host',
  'invalid_download_url',
  'download_dns_failed',
  'redirect_limit',
  'invalid_redirect',
] as const;

export type SkillManagementErrorReason = (typeof REASONS)[number] | 'unknown';

export function skillManagementErrorReason(error: unknown): SkillManagementErrorReason {
  const values: unknown[] = [error];
  if (typeof error === 'object' && error !== null) {
    values.push((error as { data?: unknown }).data, (error as { message?: unknown }).message);
  }
  const serialized = values
    .map((value) => (typeof value === 'string' ? value : (JSON.stringify(value) ?? '')))
    .join(' ');
  return REASONS.find((reason) => serialized.includes(reason)) ?? 'unknown';
}
