import { isCodeProFailureKind, type CodeProFailureKind } from '../codepro/failureSemantics';

export const ACTIVITY_EVENT_SCHEMA_VERSION = 1 as const;

export const KNOWN_ACTIVITY_EVENT_TYPES = [
  'intent_started',
  'intent_completed',
  'strategy_selected',
  'strategy_updated',
  'plan_created',
  'plan_updated',
  'task_queued',
  'task_started',
  'task_completed',
  'task_failed',
  'task_skipped',
  'tool_started',
  'tool_completed',
  'file_read',
  'file_changed',
  'command_started',
  'command_completed',
  'test_started',
  'test_completed',
  'review_started',
  'review_completed',
  'approval_requested',
  'approval_resolved',
  'run_stopped',
  'run_failed',
  'run_completed',
] as const;

export type KnownActivityEventType = (typeof KNOWN_ACTIVITY_EVENT_TYPES)[number];
export type ActivityEventType = KnownActivityEventType | 'unknown';

export const KNOWN_ACTIVITY_EVENT_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'stopped',
  'interrupted',
  'skipped',
] as const;

export type KnownActivityEventStatus = (typeof KNOWN_ACTIVITY_EVENT_STATUSES)[number];
export type ActivityEventStatus = KnownActivityEventStatus | 'unknown';
export type ActivityEventAgentRole = 'planner' | 'coder' | 'tester' | 'reviewer';
export type ActivityEventSelectedRole = ActivityEventAgentRole | 'unknown';
export type CodeProRiskTier =
  | 'l0_read_only'
  | 'l1_reversible_change'
  | 'l2_feature'
  | 'l3_high_risk_release'
  | 'unknown';
export const KNOWN_CODEPRO_RISK_REASONS = [
  'read_only',
  'focused_local_validation',
  'single_workspace_file',
  'multi_file_or_unknown_write_scope',
  'permission_boundary',
  'credential_material',
  'destructive_change',
  'outside_workspace',
  'remote_side_effect',
  'install_update_or_release',
  'user_requested_stricter_review',
] as const;
export type KnownCodeProRiskReason = (typeof KNOWN_CODEPRO_RISK_REASONS)[number];
export type CodeProRiskReason = KnownCodeProRiskReason | 'unknown';

export interface CodeProBuildProvenance {
  schema_version: 1;
  package_version: string;
  source_revision: string | null;
  source_dirty: boolean | null;
}

const knownEventTypes = new Set<string>(KNOWN_ACTIVITY_EVENT_TYPES);
const knownEventStatuses = new Set<string>(KNOWN_ACTIVITY_EVENT_STATUSES);
const knownRiskTiers = new Set<string>([
  'l0_read_only',
  'l1_reversible_change',
  'l2_feature',
  'l3_high_risk_release',
]);
const knownRiskReasons = new Set<string>(KNOWN_CODEPRO_RISK_REASONS);
const knownSelectedRoles = new Set<string>(['planner', 'coder', 'tester', 'reviewer']);

export function normalizeCodeProRiskTier(value: unknown): CodeProRiskTier | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' && knownRiskTiers.has(value)
    ? (value as Exclude<CodeProRiskTier, 'unknown'>)
    : 'unknown';
}

export function normalizeCodeProRiskReason(value: unknown): CodeProRiskReason {
  return typeof value === 'string' && knownRiskReasons.has(value)
    ? (value as KnownCodeProRiskReason)
    : 'unknown';
}

export function normalizeActivityEventType(value: unknown): ActivityEventType {
  return typeof value === 'string' && knownEventTypes.has(value)
    ? (value as KnownActivityEventType)
    : 'unknown';
}

export function normalizeActivityEventStatus(value: unknown): ActivityEventStatus {
  return typeof value === 'string' && knownEventStatuses.has(value)
    ? (value as KnownActivityEventStatus)
    : 'unknown';
}

export function isTerminalActivityEventStatus(status: ActivityEventStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'stopped' ||
    status === 'interrupted' ||
    status === 'skipped' ||
    status === 'unknown'
  );
}

export interface ActivityEvent {
  schema_version: typeof ACTIVITY_EVENT_SCHEMA_VERSION;
  event_id: string;
  tool_call_id?: string;
  event_type: ActivityEventType;
  session_id: string;
  run_id: string;
  task_id: string | null;
  parent_task_id: string | null;
  agent_role: ActivityEventAgentRole | null;
  effective_model: string | null;
  status: ActivityEventStatus;
  started_at: string;
  finished_at: string | null;
  title: string;
  technical_details: string | null;
  path: string | null;
  command_summary: string | null;
  exit_code: number | null;
  diff_summary: string | null;
  failure_kind?: CodeProFailureKind | null;
  risk_tier?: CodeProRiskTier | null;
  previous_risk_tier?: CodeProRiskTier | null;
  risk_reasons?: CodeProRiskReason[];
  selected_roles?: ActivityEventSelectedRole[];
  review_required?: boolean | null;
  routing_evidence?: {
    schema_version: number;
    build_provenance?: CodeProBuildProvenance;
  };
  include_in_model_context: boolean;
  retryable: boolean;
  retry_from_event_id: string | null;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

export function isActivityEvent(value: unknown): value is ActivityEvent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const event = value as Record<string, unknown>;
  return (
    event.schema_version === ACTIVITY_EVENT_SCHEMA_VERSION &&
    typeof event.event_id === 'string' &&
    (event.tool_call_id === undefined || typeof event.tool_call_id === 'string') &&
    normalizeActivityEventType(event.event_type) === event.event_type &&
    typeof event.session_id === 'string' &&
    typeof event.run_id === 'string' &&
    isNullableString(event.task_id) &&
    isNullableString(event.parent_task_id) &&
    (event.agent_role === null ||
      event.agent_role === 'planner' ||
      event.agent_role === 'coder' ||
      event.agent_role === 'tester' ||
      event.agent_role === 'reviewer') &&
    isNullableString(event.effective_model) &&
    normalizeActivityEventStatus(event.status) === event.status &&
    typeof event.started_at === 'string' &&
    isNullableString(event.finished_at) &&
    typeof event.title === 'string' &&
    isNullableString(event.technical_details) &&
    isNullableString(event.path) &&
    isNullableString(event.command_summary) &&
    (event.exit_code === null ||
      (typeof event.exit_code === 'number' && Number.isInteger(event.exit_code))) &&
    isNullableString(event.diff_summary) &&
    (event.failure_kind === undefined ||
      event.failure_kind === null ||
      isCodeProFailureKind(event.failure_kind)) &&
    (event.risk_tier === undefined ||
      normalizeCodeProRiskTier(event.risk_tier) === event.risk_tier) &&
    (event.previous_risk_tier === undefined ||
      normalizeCodeProRiskTier(event.previous_risk_tier) === event.previous_risk_tier) &&
    (event.risk_reasons === undefined ||
      (Array.isArray(event.risk_reasons) &&
        event.risk_reasons.every((reason) =>
          typeof reason === 'string' ? knownRiskReasons.has(reason) || reason === 'unknown' : false
        ))) &&
    (event.selected_roles === undefined ||
      (Array.isArray(event.selected_roles) &&
        event.selected_roles.every((role) =>
          typeof role === 'string' ? knownSelectedRoles.has(role) || role === 'unknown' : false
        ))) &&
    (event.review_required === undefined ||
      event.review_required === null ||
      typeof event.review_required === 'boolean') &&
    typeof event.include_in_model_context === 'boolean' &&
    typeof event.retryable === 'boolean' &&
    isNullableString(event.retry_from_event_id)
  );
}

export function parseActivityEvent(value: unknown): ActivityEvent | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.event_type !== 'string' || typeof raw.status !== 'string') {
    return null;
  }
  const candidate = {
    ...raw,
    event_type: normalizeActivityEventType(raw.event_type),
    status: normalizeActivityEventStatus(raw.status),
    failure_kind: raw.failure_kind ?? null,
    risk_tier: normalizeCodeProRiskTier(raw.risk_tier),
    previous_risk_tier: normalizeCodeProRiskTier(raw.previous_risk_tier),
    risk_reasons: Array.isArray(raw.risk_reasons)
      ? raw.risk_reasons.map(normalizeCodeProRiskReason)
      : [],
    selected_roles: Array.isArray(raw.selected_roles)
      ? raw.selected_roles.map((role) =>
          typeof role === 'string' && knownSelectedRoles.has(role) ? role : 'unknown'
        )
      : [],
    review_required:
      typeof raw.review_required === 'boolean'
        ? raw.review_required
        : (raw.review_required ?? null),
  };
  return isActivityEvent(candidate) ? candidate : null;
}
