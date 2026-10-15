export const CODEPRO_FAILURE_KINDS = [
  'policy_denied',
  'user_denied',
  'outside_workspace',
  'forbidden',
  'cancelled',
  'environment_failure',
] as const;

export type CodeProFailureKind = (typeof CODEPRO_FAILURE_KINDS)[number];

export class CodeProRollbackError extends Error {
  readonly errors: readonly unknown[];

  constructor(message: string, errors: readonly unknown[]) {
    super(message);
    this.name = 'CodeProRollbackError';
    this.errors = errors;
  }
}

export type CodeProFailureUserAction =
  | 'review_policy'
  | 'request_authorization'
  | 'choose_workspace_path'
  | 'choose_safer_action'
  | 'restart_task'
  | 'check_environment';

export interface CodeProFailureContract {
  retryable: boolean;
  userAction: CodeProFailureUserAction;
  displayZhCn: string;
}

const CONTRACTS: Record<CodeProFailureKind, CodeProFailureContract> = {
  policy_denied: {
    retryable: false,
    userAction: 'review_policy',
    displayZhCn: '需要调整操作',
  },
  user_denied: {
    retryable: false,
    userAction: 'request_authorization',
    displayZhCn: '用户未授权',
  },
  outside_workspace: {
    retryable: true,
    userAction: 'choose_workspace_path',
    displayZhCn: '等待用户授权范围',
  },
  forbidden: {
    retryable: false,
    userAction: 'choose_safer_action',
    displayZhCn: '操作被禁止',
  },
  cancelled: {
    retryable: true,
    userAction: 'restart_task',
    displayZhCn: '任务已取消',
  },
  environment_failure: {
    retryable: true,
    userAction: 'check_environment',
    displayZhCn: '环境不可用',
  },
};

export function isCodeProFailureKind(value: unknown): value is CodeProFailureKind {
  return typeof value === 'string' && CODEPRO_FAILURE_KINDS.includes(value as CodeProFailureKind);
}

export function codeProFailureContract(kind: CodeProFailureKind): CodeProFailureContract {
  return CONTRACTS[kind];
}
