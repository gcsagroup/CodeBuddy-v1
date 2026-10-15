import type { ToolExtensionSource, ToolPermissionAction } from '../types/message';
import { defineMessages, useIntl } from '../i18n';

const PROJECT_MEMORY_REMEMBER = 'project_memory_remember';
const ALLOWED_ARGUMENTS = new Set([
  'kind',
  'subject',
  'content',
  'confidence',
  'reason',
  'source_ref',
  'ttl_days',
  'scope',
  'user_confirmed',
]);
const MEMORY_KINDS = new Set(['project_rule', 'preference', 'verified_fact']);
const MEMORY_CONFIDENCE = new Set(['low', 'medium', 'high']);
const MEMORY_SCOPES = new Set(['project', 'user']);

const i18n = defineMessages({
  title: {
    id: 'projectMemoryApproval.title',
    defaultMessage: 'Review memory before saving',
  },
  warning: {
    id: 'projectMemoryApproval.warning',
    defaultMessage:
      'This memory request is malformed. Saving is unavailable; you can still deny the request.',
  },
  trimNotice: {
    id: 'projectMemoryApproval.trimNotice',
    defaultMessage:
      'The values below are shown exactly as submitted. The backend removes outer whitespace before saving.',
  },
  projectRequest: {
    id: 'projectMemoryApproval.projectRequest',
    defaultMessage: 'Project memory save request',
  },
  explicitUserRequest: {
    id: 'projectMemoryApproval.explicitUserRequest',
    defaultMessage:
      'Explicit user-preference request. The submitted marker is not proof of authorization; saving still requires host approval.',
  },
  inferredUserRequest: {
    id: 'projectMemoryApproval.inferredUserRequest',
    defaultMessage: 'Inferred user-preference candidate request',
  },
  kind: { id: 'projectMemoryApproval.kind', defaultMessage: 'Kind' },
  scope: { id: 'projectMemoryApproval.scope', defaultMessage: 'Scope' },
  confidence: { id: 'projectMemoryApproval.confidence', defaultMessage: 'Confidence' },
  ttl: { id: 'projectMemoryApproval.ttl', defaultMessage: 'TTL' },
  noTtl: { id: 'projectMemoryApproval.noTtl', defaultMessage: 'None' },
  ttlDays: { id: 'projectMemoryApproval.ttlDays', defaultMessage: '{count} days' },
  sourceRef: { id: 'projectMemoryApproval.sourceRef', defaultMessage: 'Evidence path' },
  noSourceRef: { id: 'projectMemoryApproval.noSourceRef', defaultMessage: 'None' },
  submittedConfirmation: {
    id: 'projectMemoryApproval.submittedConfirmation',
    defaultMessage: 'Submitted confirmation marker',
  },
  marked: { id: 'projectMemoryApproval.marked', defaultMessage: 'Marked true (untrusted)' },
  notMarked: {
    id: 'projectMemoryApproval.notMarked',
    defaultMessage: 'Not marked (untrusted)',
  },
  subject: { id: 'projectMemoryApproval.subject', defaultMessage: 'Subject' },
  content: { id: 'projectMemoryApproval.content', defaultMessage: 'Memory content' },
  reason: { id: 'projectMemoryApproval.reason', defaultMessage: 'Reason' },
});

export interface ProjectMemoryApprovalRequest {
  kind: 'project_rule' | 'preference' | 'verified_fact';
  subject: string;
  content: string;
  confidence: 'low' | 'medium' | 'high';
  reason: string;
  sourceRef?: string;
  ttlDays?: number;
  scope: 'project' | 'user';
  userConfirmed: boolean;
}

export type ProjectMemoryApprovalParseResult =
  | { kind: 'not_applicable' }
  | { kind: 'invalid' }
  | { kind: 'valid'; request: ProjectMemoryApprovalRequest };

function requiredString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

function safeRelativeSourceRef(value: string): boolean {
  const trimmed = value.trim();
  if (
    characterCount(trimmed) === 0 ||
    characterCount(trimmed) > 1024 ||
    /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(trimmed)
  ) {
    return false;
  }
  return !trimmed.split(/[\\/]+/).includes('..');
}

export function parseProjectMemoryApproval(
  toolName: string,
  extensionSource: ToolExtensionSource,
  argumentsValue: Record<string, unknown>
): ProjectMemoryApprovalParseResult {
  if (toolName !== PROJECT_MEMORY_REMEMBER || extensionSource !== 'platform') {
    return { kind: 'not_applicable' };
  }

  if (Object.keys(argumentsValue).some((key) => !ALLOWED_ARGUMENTS.has(key))) {
    return { kind: 'invalid' };
  }

  const { kind, subject, content, confidence, reason } = argumentsValue;
  const scope = argumentsValue.scope ?? 'project';
  const sourceRef = argumentsValue.source_ref;
  const ttlDays = argumentsValue.ttl_days;
  const userConfirmed = argumentsValue.user_confirmed ?? false;
  if (
    !requiredString(kind) ||
    !MEMORY_KINDS.has(kind) ||
    !requiredString(subject) ||
    characterCount(subject.trim()) > 120 ||
    !/^[a-z0-9][a-z0-9._-]{0,119}$/.test(subject.trim()) ||
    !requiredString(content) ||
    characterCount(content.trim()) > 2000 ||
    !requiredString(confidence) ||
    !MEMORY_CONFIDENCE.has(confidence) ||
    !requiredString(reason) ||
    characterCount(reason.trim()) > 500 ||
    typeof scope !== 'string' ||
    !MEMORY_SCOPES.has(scope) ||
    (sourceRef !== undefined && typeof sourceRef !== 'string') ||
    (ttlDays !== undefined &&
      (!Number.isInteger(ttlDays) || (ttlDays as number) < 1 || (ttlDays as number) > 3650)) ||
    typeof userConfirmed !== 'boolean'
  ) {
    return { kind: 'invalid' };
  }
  if (scope === 'user' && kind !== 'preference') return { kind: 'invalid' };
  if (kind === 'verified_fact') {
    if (typeof sourceRef !== 'string' || !safeRelativeSourceRef(sourceRef)) {
      return { kind: 'invalid' };
    }
  } else if (sourceRef !== undefined) {
    return { kind: 'invalid' };
  }

  return {
    kind: 'valid',
    request: {
      kind: kind as ProjectMemoryApprovalRequest['kind'],
      subject,
      content,
      confidence: confidence as ProjectMemoryApprovalRequest['confidence'],
      reason,
      ...(sourceRef === undefined ? {} : { sourceRef }),
      ...(ttlDays === undefined ? {} : { ttlDays: ttlDays as number }),
      scope: scope as ProjectMemoryApprovalRequest['scope'],
      userConfirmed,
    },
  };
}

export function filterProjectMemoryApprovalActions(
  result: ProjectMemoryApprovalParseResult,
  availableActions: ToolPermissionAction[] | undefined
): ToolPermissionAction[] | undefined {
  if (result.kind !== 'invalid') return availableActions;
  return (availableActions ?? ['allow_once', 'deny_once']).filter(
    (action) => action === 'deny_once' || action === 'always_deny'
  );
}

function RawValue({ label, value }: { label: string; value: string }) {
  return (
    <section>
      <h4 className="text-xs font-medium text-text-secondary">{label}</h4>
      <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background-primary p-2 text-sm text-text-primary">
        {value}
      </pre>
    </section>
  );
}

export default function ProjectMemoryApprovalSummary({
  result,
}: {
  result: ProjectMemoryApprovalParseResult;
}) {
  const intl = useIntl();
  if (result.kind === 'not_applicable') return null;

  if (result.kind === 'invalid') {
    return (
      <section
        aria-label={intl.formatMessage(i18n.title)}
        className="mt-3 rounded-xl border border-red-500/40 bg-red-500/5 p-3"
      >
        <h3 className="text-sm font-semibold text-text-primary">
          {intl.formatMessage(i18n.title)}
        </h3>
        <p className="mt-1 text-sm text-red-600" role="alert">
          {intl.formatMessage(i18n.warning)}
        </p>
      </section>
    );
  }

  const request = result.request;
  const requestDescription =
    request.scope === 'project'
      ? i18n.projectRequest
      : request.userConfirmed
        ? i18n.explicitUserRequest
        : i18n.inferredUserRequest;
  const facts = [
    [i18n.kind, request.kind],
    [i18n.scope, request.scope],
    [i18n.confidence, request.confidence],
    [
      i18n.ttl,
      request.ttlDays === undefined
        ? intl.formatMessage(i18n.noTtl)
        : intl.formatMessage(i18n.ttlDays, { count: request.ttlDays }),
    ],
    [i18n.sourceRef, request.sourceRef ?? intl.formatMessage(i18n.noSourceRef)],
    [
      i18n.submittedConfirmation,
      intl.formatMessage(request.userConfirmed ? i18n.marked : i18n.notMarked),
    ],
  ] as const;

  return (
    <section
      aria-label={intl.formatMessage(i18n.title)}
      className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3"
    >
      <h3 className="text-sm font-semibold text-text-primary">{intl.formatMessage(i18n.title)}</h3>
      <p className="mt-1 text-xs text-text-secondary">{intl.formatMessage(requestDescription)}</p>
      <p className="mt-1 text-xs text-text-secondary">{intl.formatMessage(i18n.trimNotice)}</p>
      <dl className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
        {facts.map(([label, value]) => (
          <div key={label.id} className="rounded-lg bg-background-primary px-3 py-2">
            <dt className="text-text-secondary">{intl.formatMessage(label)}</dt>
            <dd className="mt-1 break-words font-medium text-text-primary">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 space-y-3">
        <RawValue label={intl.formatMessage(i18n.subject)} value={request.subject} />
        <RawValue label={intl.formatMessage(i18n.content)} value={request.content} />
        <RawValue label={intl.formatMessage(i18n.reason)} value={request.reason} />
      </div>
    </section>
  );
}
