import { describe, expect, it } from 'vitest';
import { parseTurnTerminalRecord } from '../types/turnTerminal';
import {
  codeProRetryMode,
  codeProTerminalPresentation,
  isRetryableUserMessage,
  isTurnTerminalSuperseded,
  shouldSuppressProviderThinking,
  shouldShowMessageActions,
  shouldShowTextMessageActions,
  isRepeatedToolThinking,
} from './GooseMessage';
import type { Message } from '../types/message';

describe('copied tool thinking presentation', () => {
  const tool = (id: string, created = 10): Message => ({
    id,
    role: 'assistant',
    created,
    metadata: { userVisible: true, agentVisible: true },
    content: [
      { type: 'thinking', thinking: 'Inspect both files.', signature: '' },
      {
        type: 'toolRequest',
        id,
        toolCall: { status: 'success', value: { name: 'read_document', arguments: { path: id } } },
      },
    ],
  });
  it('hides only exact copies from the same contiguous response and preserves source data', () => {
    const first = tool('first');
    const second = tool('second');
    const messages = [first, second];
    const before = JSON.stringify(messages);
    expect(isRepeatedToolThinking(first, messages)).toBe(false);
    expect(isRepeatedToolThinking(second, messages)).toBe(true);
    expect(JSON.stringify(messages)).toBe(before);
    const later = tool('later', 20);
    expect(isRepeatedToolThinking(later, [...messages, later])).toBe(false);
    const user: Message = {
      ...first,
      id: 'user',
      role: 'user',
      content: [{ type: 'text', text: 'Continue' }],
    };
    expect(isRepeatedToolThinking(second, [first, user, second])).toBe(false);
    const explanation: Message = {
      ...first,
      id: 'explanation',
      content: [{ type: 'text', text: 'Next step' }],
    };
    expect(isRepeatedToolThinking(second, [first, explanation, second])).toBe(false);
  });
});

describe('shouldSuppressProviderThinking', () => {
  it('honors an explicit provider-thinking suppression request', () => {
    expect(shouldSuppressProviderThinking(true)).toBe(true);
  });

  it('keeps provider thinking for ordinary chat without a public summary', () => {
    expect(shouldSuppressProviderThinking(false)).toBe(false);
  });

  it('keeps streamed provider work notes visible alongside the CodePro intent summary', () => {
    expect(shouldSuppressProviderThinking(false)).toBe(false);
  });
});

describe('codeProTerminalPresentation', () => {
  it.each([
    ['completed', 'completed', 'NOT_RUN'],
    ['skipped', 'completed', 'NOT_RUN'],
    ['failed', 'failed', 'FAIL'],
    ['paused', 'paused', 'BLOCKED'],
    ['waiting_for_user', 'paused', 'WAITING_FOR_USER'],
    ['cancelled', 'cancelled', 'BLOCKED'],
    ['planning_failed', 'paused', 'BLOCKED'],
    ['scheduling_failed', 'paused', 'BLOCKED'],
    ['review_failed', 'paused', 'BLOCKED'],
    ['partial', 'paused', 'BLOCKED'],
  ] as const)('maps report outcome %s to %s / %s', (outcome, summaryStatus, verdict) => {
    expect(
      codeProTerminalPresentation({
        status:
          outcome === 'cancelled' ? 'cancelled' : outcome === 'failed' ? 'failed' : 'completed',
        report: { outcome },
      })
    ).toEqual({ summaryStatus, verdict });
  });

  it('does not present an ordinary completed turn or legacy record as a completed task', () => {
    expect(codeProTerminalPresentation({ status: 'completed' })).toBeUndefined();
    expect(codeProTerminalPresentation({ status: 'interrupted' })).toEqual({
      summaryStatus: 'paused',
      verdict: 'BLOCKED',
    });
  });

  it.each([
    [[], 'completed', 'NOT_RUN'],
    [['passed'], 'completed', 'PASS'],
    [['passed', 'passed'], 'completed', 'PASS'],
    [['passed', 'skipped'], 'completed', 'NOT_RUN'],
    [['passed', 'failed'], 'failed', 'FAIL'],
    [['passed', 'unverified'], 'paused', 'BLOCKED'],
    [['passed', 'unavailable'], 'paused', 'BLOCKED'],
  ] as const)(
    'derives the report badge from verification evidence %j',
    (verdicts, summaryStatus, verdict) => {
      expect(
        codeProTerminalPresentation({
          status: 'completed',
          report: {
            outcome: 'completed',
            verification_summary: verdicts.map((verificationVerdict, index) => ({
              task_id: `test-${index}`,
              verdict: verificationVerdict,
              command: 'node --test',
              exit_code: verificationVerdict === 'passed' ? 0 : null,
              evidence_ref: `verify-${index}`,
            })),
          },
        })
      ).toEqual({ summaryStatus, verdict });
    }
  );

  it.each([
    { outcome: 'future_outcome' },
    {
      outcome: 'completed',
      verification_summary: [
        {
          task_id: 'test-1',
          verdict: 'future_verdict',
          command: 'node --test',
          exit_code: 0,
          evidence_ref: 'verify-1',
        },
      ],
    },
  ])('never presents a present-but-invalid structured report as PASS', (invalidReport) => {
    const terminal = parseTurnTerminalRecord({
      schema_version: 1,
      session_id: 'session-1',
      run_id: 'run-1',
      terminal_message_id: 'terminal-1',
      source_user_message_id: 'user-1',
      status: 'completed',
      checkpoint_id: null,
      retry_strategy: 'not_available',
      visible_text_available: true,
      tool_action_count: 1,
      copy_artifact_ref: null,
      finished_at: '2026-08-11T00:00:00Z',
      report: {
        classification_counts: {
          confirmed_bug: 0,
          test_failure: 0,
          environment_problem: 0,
          codepro_incomplete: 0,
          unverified: 0,
        },
        changed_files: [],
        verification_summary: [],
        limitations: [],
        recovery_action: 'none',
        ...invalidReport,
      },
    });

    expect(terminal).toBeDefined();
    expect(codeProTerminalPresentation(terminal!)).toEqual({
      summaryStatus: 'paused',
      verdict: 'BLOCKED',
    });
  });
});

describe('isRetryableUserMessage', () => {
  it('accepts an image-only user request', () => {
    expect(
      isRetryableUserMessage({
        id: 'image-request',
        role: 'user',
        created: 1,
        content: [{ type: 'image', data: 'image-data', mimeType: 'image/png' }],
        metadata: { userVisible: true, agentVisible: true },
      })
    ).toBe(true);
  });

  it('rejects assistant content as a retry source', () => {
    expect(
      isRetryableUserMessage({
        id: 'assistant-message',
        role: 'assistant',
        created: 1,
        content: [{ type: 'text', text: 'Answer' }],
        metadata: { userVisible: true, agentVisible: true },
      })
    ).toBe(false);
  });
});

describe('shouldShowMessageActions', () => {
  it('shows actions for completed assistant text even when the message also used tools or thinking', () => {
    expect(shouldShowMessageActions('最终回复', false)).toBe(true);
  });

  it('hides actions while streaming or when there is no final text', () => {
    expect(shouldShowMessageActions('正在生成', true)).toBe(false);
    expect(shouldShowMessageActions('   ', false)).toBe(false);
  });

  it('shows one action anchor for a terminal tool turn without final text', () => {
    expect(
      shouldShowMessageActions('', false, {
        status: 'cancelled',
        retry_strategy: 'replay_user_request',
      })
    ).toBe(true);
  });

  it('hides actions on earlier partial text when the turn has a terminal anchor', () => {
    expect(shouldShowMessageActions('Partial result', false, undefined, true)).toBe(false);
  });
});

describe('codeProRetryMode', () => {
  it.each([
    ['ordinary assistant reply', undefined, 'resubmit'],
    [
      'paused checkpoint',
      { checkpoint_id: 'checkpoint-1', retry_strategy: 'continue_checkpoint' },
      'continue',
    ],
    [
      'cancelled run with source request',
      { checkpoint_id: null, retry_strategy: 'replay_user_request' },
      'replay',
    ],
    [
      'failed deterministic validation',
      { checkpoint_id: null, retry_strategy: 'retry_failed_validation' },
      'retry_validation',
    ],
    [
      'terminal without a safe retry',
      { checkpoint_id: null, retry_strategy: 'not_available' },
      'none',
    ],
  ] as const)('maps %s to the structured operation %s', (_name, terminal, expected) => {
    expect(codeProRetryMode('localized display text is irrelevant', terminal as never)).toBe(
      expected
    );
  });

  it('continues only when the terminal record provides a checkpoint strategy', () => {
    expect(
      codeProRetryMode('localized display text must not control retry', {
        checkpoint_id: 'checkpoint-1',
        retry_strategy: 'continue_checkpoint',
      })
    ).toBe('continue');
  });

  it('does not infer checkpoint retry from localized report text', () => {
    expect(
      codeProRetryMode(
        '本轮操作测试 Agent 行动已上限，当前进度已经保存。CodePro 将从检查点继续执行。您可以点击重试继续执行。'
      )
    ).toBe('resubmit');
  });

  it('uses a linked replay for a terminal without a checkpoint', () => {
    expect(
      codeProRetryMode('Stopped', {
        checkpoint_id: null,
        retry_strategy: 'replay_user_request',
      })
    ).toBe('replay');
  });

  it('uses deterministic validation retry only for the structured strategy', () => {
    expect(
      codeProRetryMode('localized text is irrelevant', {
        checkpoint_id: null,
        retry_strategy: 'retry_failed_validation',
      } as never)
    ).toBe('retry_validation');
  });

  it('supersedes a failed validation terminal only through its direct successor link', () => {
    const source = {
      id: 'failed-terminal-1',
      role: 'assistant',
      created: 1,
      content: [],
      metadata: { userVisible: true, agentVisible: true },
    } as never;
    const successor = {
      id: 'failed-terminal-2',
      role: 'assistant',
      created: 2,
      content: [
        {
          type: 'systemNotification',
          notificationType: 'turnTerminal',
          msg: 'retry failed',
          data: {
            schema_version: 1,
            session_id: 'session-1',
            run_id: 'run-2',
            terminal_message_id: 'failed-terminal-2',
            source_user_message_id: 'retry-user-1',
            status: 'failed',
            checkpoint_id: null,
            retry_strategy: 'retry_failed_validation',
            visible_text_available: true,
            tool_action_count: 1,
            copy_artifact_ref: null,
            finished_at: '2026-08-01T12:01:00Z',
            retry_of_terminal_message_id: 'failed-terminal-1',
            validation_retry: {
              target_path: 'D:\\project\\app.rs',
              command: 'cargo check',
              exit_code: 1,
            },
          },
        },
      ],
      metadata: { userVisible: true, agentVisible: true },
    } as never;

    expect(isTurnTerminalSuperseded(source, [source, successor])).toBe(true);
  });

  it('resubmits ordinary assistant retries in the current session', () => {
    expect(codeProRetryMode('普通回答')).toBe('resubmit');
  });

  it('does not offer retry for a terminal whose structured strategy is unavailable', () => {
    expect(
      codeProRetryMode('单文件修改终态：PASS', {
        checkpoint_id: null,
        retry_strategy: 'not_available',
      })
    ).toBe('none');
  });
});

describe('shouldShowTextMessageActions', () => {
  it('leaves the single action group on the terminal card when a report also has text', () => {
    expect(shouldShowTextMessageActions(true, true)).toBe(false);
    expect(shouldShowTextMessageActions(true, false)).toBe(true);
  });
});
