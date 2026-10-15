import { isRecord } from './shared';
import { isCodeProFailureKind, type CodeProFailureKind } from '../../codepro/failureSemantics';

const TOOL_AUDIT_V1_KEYS = new Set([
  'schemaVersion',
  'auditId',
  'actor',
  'effectiveModel',
  'extensionSource',
  'toolName',
  'permissionClass',
  'authorization',
  'outcome',
  'taskScoped',
  'startedAt',
  'completedAt',
  'durationMs',
]);
const TOOL_AUDIT_V2_KEYS = new Set([...TOOL_AUDIT_V1_KEYS, 'failureKind']);

const TOOL_AUDIT_ACTORS = [
  'primary',
  'codepro_planner',
  'codepro_coder',
  'codepro_tester',
  'codepro_reviewer',
  'host_unknown',
] as const;
const TOOL_AUDIT_EXTENSION_SOURCES = [
  'platform',
  'builtin',
  'external_stdio',
  'external_http',
  'frontend',
  'inline_python',
  'unknown',
] as const;
const TOOL_AUDIT_PERMISSION_CLASSES = [
  'read_only',
  'workspace_write',
  'external_write',
  'high_risk',
  'forbidden',
  'legacy',
] as const;
const TOOL_AUDIT_AUTHORIZATIONS = [
  'policy_allowed',
  'user_confirmed',
  'policy_denied',
  'user_denied',
] as const;
const TOOL_AUDIT_OUTCOMES = [
  'success',
  'tool_error',
  'cancelled',
  'timed_out',
  'replay_suppressed',
  'ambiguous',
  'policy_denied',
  'user_denied',
] as const;

export type ToolAuditActor = (typeof TOOL_AUDIT_ACTORS)[number];
export type ToolAuditExtensionSource = (typeof TOOL_AUDIT_EXTENSION_SOURCES)[number];
export type ToolAuditPermissionClass = (typeof TOOL_AUDIT_PERMISSION_CLASSES)[number];
export type ToolAuditAuthorization = (typeof TOOL_AUDIT_AUTHORIZATIONS)[number];
export type ToolAuditOutcome = (typeof TOOL_AUDIT_OUTCOMES)[number];

interface ToolAuditReceiptBase {
  auditId: string;
  actor: ToolAuditActor;
  effectiveModel: string;
  extensionSource: ToolAuditExtensionSource;
  toolName: string;
  permissionClass: ToolAuditPermissionClass;
  authorization: ToolAuditAuthorization;
  outcome: ToolAuditOutcome;
  taskScoped: boolean;
  taskScopeDigest?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface ToolAuditReceiptV1 extends ToolAuditReceiptBase {
  schemaVersion: 1;
}

export interface ToolAuditReceiptV2 extends ToolAuditReceiptBase {
  schemaVersion: 2;
  failureKind: CodeProFailureKind | null;
}

export type ToolAuditReceipt = ToolAuditReceiptV1 | ToolAuditReceiptV2;

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && allowed.includes(value as T);
}

function isSafeEffectiveModel(value: unknown): value is string {
  if (value === 'unknown') return true;
  if (typeof value !== 'string' || value.length > 512) return false;
  const [provider, ...models] = value.split('/');
  return (
    models.length > 0 &&
    /^[A-Za-z0-9._-]{1,128}$/.test(provider) &&
    models.every((model) => /^[A-Za-z0-9._:-]{1,256}$/.test(model))
  );
}

function isSafeToolName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}::[A-Za-z0-9._-]{1,128}$/.test(value);
}

function timestamp(value: unknown): number | undefined {
  if (
    typeof value !== 'string' ||
    value.length > 64 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
  ) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseToolAuditReceipt(value: unknown): ToolAuditReceipt | undefined {
  if (!isRecord(value)) return undefined;
  const expectedKeys =
    value.schemaVersion === 1
      ? TOOL_AUDIT_V1_KEYS
      : value.schemaVersion === 2
        ? TOOL_AUDIT_V2_KEYS
        : undefined;
  if (
    !expectedKeys ||
    ![...expectedKeys].every((key) => key in value) ||
    !Object.keys(value).every((key) => expectedKeys.has(key) || key === 'taskScopeDigest') ||
    (value.taskScopeDigest !== undefined &&
      (typeof value.taskScopeDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.taskScopeDigest)))
  ) {
    return undefined;
  }

  const startedAt = timestamp(value.startedAt);
  const completedAt = timestamp(value.completedAt);
  if (
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    typeof value.auditId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.auditId) ||
    !isOneOf(value.actor, TOOL_AUDIT_ACTORS) ||
    !isSafeEffectiveModel(value.effectiveModel) ||
    !isOneOf(value.extensionSource, TOOL_AUDIT_EXTENSION_SOURCES) ||
    !isSafeToolName(value.toolName) ||
    !isOneOf(value.permissionClass, TOOL_AUDIT_PERMISSION_CLASSES) ||
    !isOneOf(value.authorization, TOOL_AUDIT_AUTHORIZATIONS) ||
    !isOneOf(value.outcome, TOOL_AUDIT_OUTCOMES) ||
    typeof value.taskScoped !== 'boolean' ||
    startedAt === undefined ||
    completedAt === undefined ||
    completedAt < startedAt ||
    !Number.isSafeInteger(value.durationMs) ||
    (value.durationMs as number) < 0
  ) {
    return undefined;
  }

  if (value.schemaVersion === 2) {
    if (value.failureKind !== null && !isCodeProFailureKind(value.failureKind)) {
      return undefined;
    }
    if (
      !failureMatchesAudit(
        value.authorization as ToolAuditAuthorization,
        value.permissionClass as ToolAuditPermissionClass,
        value.outcome as ToolAuditOutcome,
        value.failureKind as CodeProFailureKind | null
      )
    ) {
      return undefined;
    }
  }

  return value as unknown as ToolAuditReceipt;
}

function failureMatchesAudit(
  authorization: ToolAuditAuthorization,
  permissionClass: ToolAuditPermissionClass,
  outcome: ToolAuditOutcome,
  failureKind: CodeProFailureKind | null
): boolean {
  if (outcome === 'policy_denied') {
    return (
      authorization === 'policy_denied' &&
      failureKind === (permissionClass === 'forbidden' ? 'forbidden' : 'policy_denied')
    );
  }
  if (outcome === 'user_denied') {
    return authorization === 'user_denied' && failureKind === 'user_denied';
  }
  if (outcome === 'cancelled') return failureKind === 'cancelled';
  if (outcome === 'tool_error') {
    return (
      failureKind === null ||
      failureKind === 'outside_workspace' ||
      failureKind === 'environment_failure'
    );
  }
  return failureKind === null;
}

export function toolAuditReceiptFromMeta(meta: unknown): ToolAuditReceipt | undefined {
  if (!isRecord(meta) || !isRecord(meta.goose)) return undefined;
  return parseToolAuditReceipt(meta.goose.toolAudit);
}
