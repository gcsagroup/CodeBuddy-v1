import { describe, expect, it } from 'vitest';
import type { ActivityEvent } from '../types/activityEvent';
import type { Message } from '../types/message';
import type { TurnTerminalRecord } from '../types/turnTerminal';
import {
  buildTerminalExecutionSummary,
  getAssistantMessageActionPolicy,
  resolveAssistantCopyText,
} from './messageActionsModel';

const sourceMessage = {
  id: 'user-1',
  role: 'user',
  created: 1,
  content: [{ type: 'text', text: '请修改项目' }],
  metadata: { userVisible: true, agentVisible: true },
} as Message;

const terminal: TurnTerminalRecord = {
  schema_version: 1,
  session_id: 'session-1',
  run_id: 'run-1',
  terminal_message_id: 'terminal-1',
  source_user_message_id: 'user-1',
  status: 'cancelled',
  checkpoint_id: null,
  retry_strategy: 'replay_user_request',
  visible_text_available: false,
  tool_action_count: 4,
  copy_artifact_ref: null,
  finished_at: '2026-08-02T08:00:00Z',
};

function event(overrides: Partial<ActivityEvent>): ActivityEvent {
  return {
    schema_version: 1,
    event_id: 'event-1',
    event_type: 'file_read',
    session_id: 'session-1',
    run_id: 'run-1',
    task_id: 'task-1',
    parent_task_id: null,
    agent_role: 'coder',
    effective_model: null,
    status: 'completed',
    started_at: '2026-08-02T07:59:00Z',
    finished_at: '2026-08-02T07:59:01Z',
    title: '读取文件',
    technical_details: null,
    path: 'D:\\project\\src\\app.ts',
    command_summary: null,
    exit_code: null,
    diff_summary: null,
    include_in_model_context: true,
    retryable: false,
    retry_from_event_id: null,
    ...overrides,
  };
}

function activityMessage(activity: ActivityEvent, id = activity.event_id): Message {
  return {
    id,
    role: 'assistant',
    created: 2,
    content: [
      {
        type: 'systemNotification',
        notificationType: 'codeProActivity',
        msg: activity.title,
        data: activity,
      },
    ],
    metadata: { userVisible: true, agentVisible: false },
  };
}

describe('getAssistantMessageActionPolicy', () => {
  it('hides assistant actions while streaming', () => {
    expect(
      getAssistantMessageActionPolicy({
        displayText: '正在生成',
        isStreaming: true,
      })
    ).toEqual({
      showActionGroup: false,
      copySource: null,
      retryMode: 'none',
      showTextActionGroup: false,
    });
  });

  it('shows copy and retry for an ordinary final answer', () => {
    expect(
      getAssistantMessageActionPolicy({
        displayText: '最终回答',
        isStreaming: false,
      })
    ).toEqual({
      showActionGroup: true,
      copySource: 'text',
      retryMode: 'resubmit',
      showTextActionGroup: true,
    });
  });

  it('uses one terminal action group when a structured terminal also has text', () => {
    expect(
      getAssistantMessageActionPolicy({
        displayText: '部分结果',
        isStreaming: false,
        terminal: {
          checkpoint_id: null,
          retry_strategy: 'replay_user_request',
        },
      })
    ).toEqual({
      showActionGroup: true,
      copySource: 'terminal',
      retryMode: 'replay',
      showTextActionGroup: false,
    });
  });

  it('keeps copy but disables retry for an unavailable terminal', () => {
    expect(
      getAssistantMessageActionPolicy({
        displayText: '',
        isStreaming: false,
        terminal: {
          checkpoint_id: null,
          retry_strategy: 'not_available',
        },
      })
    ).toMatchObject({
      showActionGroup: true,
      copySource: 'terminal',
      retryMode: 'none',
    });
  });

  it('waits for a typed user answer instead of offering a context-free checkpoint retry', () => {
    expect(
      getAssistantMessageActionPolicy({
        displayText: '正在等待用户确认命令。',
        isStreaming: false,
        terminal: {
          checkpoint_id: 'checkpoint-1',
          retry_strategy: 'continue_checkpoint',
          report: { recovery_action: 'ask_user' },
        },
      })
    ).toMatchObject({
      showActionGroup: true,
      copySource: 'terminal',
      retryMode: 'none',
    });
  });

  it('hides actions for a terminal superseded by a linked run', () => {
    expect(
      getAssistantMessageActionPolicy({
        displayText: '',
        isStreaming: false,
        superseded: true,
        terminal: {
          checkpoint_id: 'checkpoint-1',
          retry_strategy: 'continue_checkpoint',
        },
      }).showActionGroup
    ).toBe(false);
  });
});

describe('buildTerminalExecutionSummary', () => {
  it('summarizes completed work, stop position, paths, results and retry strategy', () => {
    const messages = [
      sourceMessage,
      activityMessage(event({ event_id: 'read-1' })),
      activityMessage(
        event({
          event_id: 'change-1',
          event_type: 'file_changed',
          path: 'D:\\project\\src\\app.ts',
          diff_summary: '1 file changed',
        })
      ),
      activityMessage(
        event({
          event_id: 'test-1',
          event_type: 'test_started',
          status: 'running',
          path: null,
          command_summary: 'pnpm test --token TOP_SECRET',
          technical_details: 'Authorization: Bearer TOP_SECRET\nfull private output',
          finished_at: null,
        })
      ),
    ];

    expect(buildTerminalExecutionSummary(terminal, messages)).toEqual({
      status: 'cancelled',
      completedActions: ['Read D:\\project\\src\\app.ts', 'Changed D:\\project\\src\\app.ts'],
      stopPosition: 'Testing',
      paths: ['D:\\project\\src\\app.ts'],
      results: ['4 tool actions preserved', '1 file changed'],
      retryStrategy: 'replay_user_request',
    });
  });

  it('merges an activity lifecycle and isolates the source run', () => {
    const started = event({
      event_id: 'test-1',
      event_type: 'test_started',
      status: 'running',
      path: null,
      finished_at: null,
    });
    const completed = event({
      ...started,
      event_type: 'test_completed',
      status: 'completed',
      finished_at: '2026-08-02T07:59:03Z',
      exit_code: 0,
    });
    const otherRun = event({
      event_id: 'secret-1',
      run_id: 'run-other',
      path: 'D:\\secret\\credentials.txt',
    });

    const summary = buildTerminalExecutionSummary(terminal, [
      sourceMessage,
      activityMessage(started, 'started'),
      activityMessage(completed, 'completed'),
      activityMessage(otherRun, 'other'),
    ]);

    expect(summary.completedActions).toEqual(['Tested (exit code 0)']);
    expect(summary.stopPosition).toBeNull();
    expect(summary.paths).not.toContain('D:\\secret\\credentials.txt');
  });

  it('never includes raw commands, technical output, tokens or file contents', () => {
    const sensitive = event({
      event_id: 'command-1',
      event_type: 'command_completed',
      path: null,
      command_summary: 'curl -H "Authorization: Bearer TOP_SECRET" https://example.test',
      technical_details: 'PRIVATE_FILE_CONTENT TOP_SECRET',
      exit_code: 7,
    });

    const serialized = JSON.stringify(
      buildTerminalExecutionSummary(terminal, [sourceMessage, activityMessage(sensitive)])
    );
    expect(serialized).toContain('Command finished (exit code 7)');
    expect(serialized).not.toMatch(/TOP_SECRET|Authorization|curl|PRIVATE_FILE_CONTENT/);
  });

  it('falls back to the terminal record when no structured activity exists', () => {
    expect(buildTerminalExecutionSummary(terminal, [sourceMessage])).toEqual({
      status: 'cancelled',
      completedActions: [],
      stopPosition: null,
      paths: [],
      results: ['4 tool actions preserved'],
      retryStrategy: 'replay_user_request',
    });
  });
});

describe('resolveAssistantCopyText', () => {
  it('copies the final assistant answer when terminal text is available', () => {
    expect(resolveAssistantCopyText('最终答案', terminal, [sourceMessage])).toBe('最终答案');
  });

  it('degrades a no-text terminal to an explanatory structured summary', () => {
    const copy = resolveAssistantCopyText('   ', terminal, [sourceMessage]);
    expect(copy).toContain('Status: Cancelled');
    expect(copy).toContain('Existing results: 4 tool actions preserved');
    expect(copy).toContain('Retry: Replay the original request as a linked run');
  });
});
