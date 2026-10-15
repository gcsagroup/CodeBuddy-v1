import { describe, expect, it } from 'vitest';
import {
  CODEPRO_FAILURE_KINDS,
  codeProFailureContract,
  type CodeProFailureKind,
} from './failureSemantics';

describe('CodePro failure semantics', () => {
  it('keeps one fixed contract for every host failure fact', () => {
    const expected: Record<
      CodeProFailureKind,
      { retryable: boolean; userAction: string; displayZhCn: string }
    > = {
      policy_denied: { retryable: false, userAction: 'review_policy', displayZhCn: '需要调整操作' },
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
      cancelled: { retryable: true, userAction: 'restart_task', displayZhCn: '任务已取消' },
      environment_failure: {
        retryable: true,
        userAction: 'check_environment',
        displayZhCn: '环境不可用',
      },
    };

    expect(new Set(CODEPRO_FAILURE_KINDS).size).toBe(6);
    for (const kind of CODEPRO_FAILURE_KINDS) {
      expect(codeProFailureContract(kind)).toEqual(expected[kind]);
    }
  });
});
