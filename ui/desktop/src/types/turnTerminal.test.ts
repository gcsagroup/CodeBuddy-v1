import { describe, expect, it } from 'vitest';
import { isTurnTerminalRecord, parseTurnTerminalRecord, stoppedRequestToContinue } from './turnTerminal';
import { createUserMessage, type Message } from './message';

const base = {
  schema_version: 1,
  session_id: 'session-1',
  run_id: 'run-1',
  terminal_message_id: 'terminal-1',
  source_user_message_id: 'user-1',
  status: 'completed',
  checkpoint_id: null,
  retry_strategy: 'not_available',
  visible_text_available: true,
  tool_action_count: 0,
  copy_artifact_ref: null,
  finished_at: '2026-08-06T00:00:00Z',
} as const;

it('continues only the latest stopped request, including a stopped hidden continuation', () => {
  const user = { ...createUserMessage('Create my project'), id: 'user-1' };
  const stopped: Message = { ...user, role: 'assistant', id: 'terminal-1', content: [{
    type: 'systemNotification', notificationType: 'turnTerminal', msg: 'Stopped',
    data: { ...base, status: 'cancelled' },
  }] };
  const resumed: Message = { ...user, id: 'resume', metadata: { ...user.metadata, userVisible: false,
    presentation: { afterMessageId: 'terminal-1', continuation: true } } };
  expect(stoppedRequestToContinue([user, stopped])).toBe(user.id);
  const toolResult: Message = { ...user, id: 'receipt', content: [
    { type: 'toolResponse', id: 'write-8', toolResult: { status: 'success', value: {} } },
  ] };
  expect(stoppedRequestToContinue([user, toolResult, stopped])).toBe(user.id);
  expect(stoppedRequestToContinue([user, stopped, resumed])).toBeUndefined();
  expect(stoppedRequestToContinue([user, resumed, stopped])).toBeUndefined();
  expect(stoppedRequestToContinue([user, stopped, createUserMessage('Another task')])).toBeUndefined();
  const repeated: Message = { ...stopped, content: [{ type: 'systemNotification', notificationType: 'turnTerminal',
    msg: 'Stopped', data: { ...base, source_user_message_id: resumed.id, status: 'cancelled' } }] };
  expect(stoppedRequestToContinue([user, stopped, resumed, repeated])).toBe(user.id);
});

it('invalid diagnostic fields never invalidate terminal/retry facts or expose arbitrary error payloads', () => {
  const withDiagnostic = parseTurnTerminalRecord({
    ...base,
    diagnostic: {
      code: 'AUTH',
      httpStatus: 401,
      message: 'PRIVATE',
      transportCodes: ['PRIVATE'],
    },
  });
  expect(withDiagnostic?.diagnostic).toEqual({ code: 'AUTH', httpStatus: 401 });
  for (const diagnostic of [null, 'PRIVATE', { code: 'PRIVATE', httpStatus: 'PRIVATE' }]) {
    const record = parseTurnTerminalRecord({ ...base, diagnostic });
    expect(record?.retry_strategy).toBe(base.retry_strategy);
    expect(record?.status).toBe(base.status);
    expect(record?.diagnostic).toBeUndefined();
  }
});

it('degrades malformed optional output budget details without rejecting old terminals', () => {
  expect(parseTurnTerminalRecord(base)?.stop_reason).toBeUndefined();
  const record = parseTurnTerminalRecord({
    ...base,
    stop_reason: 'max_tokens',
    output_limit: {
      automaticAttempts: 1,
      maxAutomaticAttempts: 1,
      budget: { requestedTokens: 'invalid' },
    },
  });
  expect(record?.stop_reason).toBe('max_tokens');
  expect(record?.output_limit?.automaticAttempts).toBe(1);
  expect(record?.output_limit?.budget).toBeUndefined();
  expect(
    parseTurnTerminalRecord({
      ...base,
      output_limit: { automaticAttempts: 2, maxAutomaticAttempts: 1 },
    })?.output_limit
  ).toBeUndefined();
});

it('reads both legacy and two-attempt recovery annotations without accepting over-budget counts', () => {
  for (const maxAutomaticAttempts of [1, 2]) {
    const output_limit = { automaticAttempts: maxAutomaticAttempts, maxAutomaticAttempts };
    expect(parseTurnTerminalRecord({ ...base, output_limit })?.output_limit).toEqual(output_limit);
  }
  for (const automaticAttempts of [-1, 1.5, 3]) {
    expect(
      parseTurnTerminalRecord({
        ...base,
        output_limit: { automaticAttempts, maxAutomaticAttempts: 2 },
      })?.output_limit
    ).toBeUndefined();
  }
});

const report = {
  outcome: 'completed',
  classification_counts: {
    confirmed_bug: 1,
    test_failure: 0,
    environment_problem: 0,
    codepro_incomplete: 0,
    unverified: 0,
  },
  changed_files: ['src/main.rs'],
  verification_summary: [
    {
      task_id: 'test-1',
      verdict: 'passed',
      command: 'cargo test',
      exit_code: 0,
      evidence_ref: 'verify-1',
    },
  ],
  limitations: [],
  recovery_action: 'none',
} as const;

describe('TurnTerminal CodePro report contract', () => {
  it('accepts the structured Rust-compatible payload', () => {
    expect(parseTurnTerminalRecord({ ...base, report })).toMatchObject({ report });
  });

  it('accepts a completed terminal whose dynamic validation was explicitly skipped', () => {
    expect(
      parseTurnTerminalRecord({
        ...base,
        report: {
          ...report,
          outcome: 'skipped',
          classification_counts: { ...report.classification_counts, confirmed_bug: 0 },
          verification_summary: [
            {
              task_id: 'host-fallback-verify',
              verdict: 'skipped',
              command: null,
              exit_code: null,
              evidence_ref: 'verify-1',
            },
          ],
        },
      })
    ).toMatchObject({ status: 'completed', report: { outcome: 'skipped' } });
  });

  it('preserves terminal risk and review state and fails closed for a future tier', () => {
    const parsed = parseTurnTerminalRecord({
      ...base,
      report: {
        ...report,
        risk_tier: 'l3_high_risk_release',
        risk_reasons: ['remote_side_effect'],
        review_required: true,
      },
    });
    expect(parsed?.report).toMatchObject({
      risk_tier: 'l3_high_risk_release',
      risk_reasons: ['remote_side_effect'],
      review_required: true,
    });

    expect(
      parseTurnTerminalRecord({
        ...base,
        report: {
          ...report,
          risk_tier: 'l4_future',
          risk_reasons: ['future_reason'],
          review_required: true,
        },
      })?.report
    ).toMatchObject({ risk_tier: 'unknown', risk_reasons: ['unknown'], review_required: true });
  });

  it('keeps legacy terminal records without a report', () => {
    expect(parseTurnTerminalRecord(base)).toEqual(base);
  });

  it('preserves an optional final-response observation and drops malformed observations only', () => {
    expect(parseTurnTerminalRecord({ ...base, last_response_text_available: false })).toMatchObject(
      { status: 'completed', last_response_text_available: false }
    );
    const parsed = parseTurnTerminalRecord({ ...base, last_response_text_available: 'false' });
    expect(parsed).toEqual(base);
  });

  it('accepts a cancellation only when its structured recovery contract matches', () => {
    const cancelled = {
      ...base,
      status: 'cancelled',
      retry_strategy: 'replay_user_request',
      failure_kind: 'cancelled',
      retryable: true,
      user_action: 'restart_task',
    };

    expect(parseTurnTerminalRecord(cancelled)).toEqual(cancelled);
    expect(parseTurnTerminalRecord({ ...cancelled, retryable: false })).toBeUndefined();
    expect(parseTurnTerminalRecord({ ...cancelled, user_action: 'review_policy' })).toBeUndefined();
  });

  it('rejects a completed terminal carrying a host failure contract', () => {
    expect(
      parseTurnTerminalRecord({
        ...base,
        failure_kind: 'user_denied',
        retryable: false,
        user_action: 'request_authorization',
      })
    ).toBeUndefined();
  });

  it('rejects terminal and report outcomes that describe conflicting states', () => {
    expect(
      parseTurnTerminalRecord({
        ...base,
        report: { ...report, outcome: 'review_failed', recovery_action: 'retry_review' },
      })
    ).toBeUndefined();
  });

  it('tolerates unknown future fields', () => {
    const parsed = parseTurnTerminalRecord({
      ...base,
      future_base_field: true,
      report: { ...report, future_report_field: 'kept-compatible' },
    });
    expect(parsed?.report?.outcome).toBe('completed');
  });

  it.each([
    { ...report, outcome: 'invented_outcome' },
    { ...report, recovery_action: 'invented_action' },
    {
      ...report,
      verification_summary: [{ ...report.verification_summary[0], verdict: 'maybe' }],
    },
  ])('marks an invalid known report extension without hiding visible terminal text', (invalid) => {
    const raw = { ...base, report: invalid };
    const parsed = parseTurnTerminalRecord(raw);
    expect(parsed).toBeDefined();
    expect(parsed?.visible_text_available).toBe(true);
    expect(parsed?.report).toBeUndefined();
    expect(parsed?.report_parse_failed).toBe(true);
    expect(isTurnTerminalRecord(raw)).toBe(false);
  });
});
