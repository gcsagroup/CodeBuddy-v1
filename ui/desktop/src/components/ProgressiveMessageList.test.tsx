import { act, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import type { ActivityEvent } from '../types/activityEvent';
import type { Message } from '../types/message';
import { isTurnTerminalRecord } from '../types/turnTerminal';
import ProgressiveMessageList from './ProgressiveMessageList';
import { CodeProPlanDock } from './codepro/CodeProPlanDock';
import { applyGooseSessionNotification } from '../acp/adapter/gooseSessionNotifications';
import type { AdapterState } from '../acp/adapter/shared';
import { createAcpSessionNotificationAdapter } from '../acp/sessionNotificationAdapter';
import {
  cancelAcpPermissionRequestsForSession,
  requestAcpPermission,
  resolveAcpPermissionRequest,
} from '../acp/permissionRequests';

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});
function compactGroups() {
  return screen
    .getAllByTestId('message-container')
    .filter((element) => element.querySelector('.codepro-group-heading'));
}

function message(index: number): Message {
  return {
    id: `message-${index}`,
    role: 'assistant',
    created: index,
    content: [{ type: 'text', text: `message ${index}` }],
    metadata: { userVisible: true, agentVisible: true },
  };
}

function activity(overrides: Partial<ActivityEvent>): ActivityEvent {
  return {
    schema_version: 1,
    event_id: 'event-1',
    event_type: 'file_read',
    session_id: 'activity-session',
    run_id: 'run-1',
    task_id: 'task-1',
    parent_task_id: null,
    agent_role: 'coder',
    effective_model: 'provider/model',
    status: 'running',
    started_at: '2026-08-02T08:00:00.000Z',
    finished_at: null,
    title: '正在执行动作',
    technical_details: null,
    path: null,
    command_summary: null,
    exit_code: null,
    diff_summary: null,
    include_in_model_context: false,
    retryable: false,
    retry_from_event_id: null,
    ...overrides,
  };
}

function activityMessage(index: number, event: ActivityEvent): Message {
  return {
    id: `activity-${index}`,
    role: 'assistant',
    created: index,
    content: [
      {
        type: 'systemNotification',
        notificationType: 'codeProActivity',
        msg: `CodePro · ${event.title}`,
        data: event,
      },
    ],
    metadata: { userVisible: true, agentVisible: false },
  };
}

function toolTransportMessage(index: number, id: string, type: 'request' | 'response'): Message {
  return {
    id: `tool-${type}-${index}`,
    role: type === 'request' ? 'assistant' : 'user',
    created: index,
    content:
      type === 'request'
        ? [
            {
              type: 'toolRequest',
              id,
              toolCall: { name: 'developer__read', arguments: { path: 'README.md' } },
            },
          ]
        : [
            {
              type: 'toolResponse',
              id,
              toolResult: {
                status: 'success',
                value: { content: [{ type: 'text', text: 'done' }], isError: false },
              },
            },
          ],
    metadata: { userVisible: type === 'request', agentVisible: true },
  } as Message;
}

function terminalMessage(
  retryStrategy: 'replay_user_request' | 'continue_checkpoint' | 'not_available',
  options: { askUser?: boolean; checkpointId?: string | null } = {}
): Message {
  const finishedAt = 205;
  return {
    id: `terminal-${retryStrategy}`,
    role: 'assistant',
    created: finishedAt,
    content: [
      {
        type: 'systemNotification',
        notificationType: 'turnTerminal',
        msg: 'Turn interrupted',
        data: {
          schema_version: 1,
          session_id: 'terminal-session',
          run_id: 'run-1',
          terminal_message_id: `terminal-${retryStrategy}`,
          source_user_message_id: 'source-user',
          status: 'interrupted',
          checkpoint_id: options.checkpointId ?? null,
          retry_strategy: retryStrategy,
          visible_text_available: false,
          tool_action_count: 1,
          copy_artifact_ref: null,
          finished_at: new Date(finishedAt * 1000).toISOString(),
          ...(options.askUser
            ? {
                report: {
                  outcome: 'waiting_for_user',
                  classification_counts: {
                    confirmed_bug: 0,
                    test_failure: 0,
                    environment_problem: 0,
                    codepro_incomplete: 1,
                    unverified: 0,
                  },
                  changed_files: [],
                  verification_summary: [],
                  limitations: ['User input required'],
                  recovery_action: 'ask_user',
                },
              }
            : {}),
        },
      },
    ],
    metadata: { userVisible: true, agentVisible: false },
  } as Message;
}

const sourceUserMessage: Message = {
  id: 'source-user',
  role: 'user',
  created: 1,
  content: [{ type: 'text', text: 'Analyze this project' }],
  metadata: { userVisible: true, agentVisible: true },
};

it('keeps native lifecycle captions at the same disclosure level as ordinary work records', async () => {
  const adapter = createAcpSessionNotificationAdapter([sourceUserMessage]);
  for (const phase of ['start', 'end'] as const)
    adapter.apply({
      sessionId: 'terminal-session',
      update: {
        sessionUpdate: 'session_info_update',
        _meta: {
          goose: {
            subagentLifecycle: {
              type: 'subagent_lifecycle',
              schema_version: 1,
              event_id: `child:${phase}`,
              session_id: 'terminal-session',
              child_session_id: 'native-child',
              activation_id: 'activation',
              phase,
              label: 'Code review',
              created_at: 2,
            },
          },
        },
      },
    });
  const messages = adapter.getMessages();
  const props = {
    chat: { sessionId: 'terminal-session' },
    sessionType: 'code_pro' as const,
    isUserMessage: (message: Message) => message.role === 'user',
  };
  const view = render(
    <ProgressiveMessageList {...props} messages={messages} isStreamingMessage />,
    { wrapper: IntlTestWrapper }
  );
  expect(screen.getByRole('button', { name: 'Code review started working' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Code review ended' })).toBeVisible();
  view.rerender(
    <ProgressiveMessageList {...props} messages={[...messages, terminalMessage('not_available')]} />
  );
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Code review ended' })).toBeNull()
  );
  fireEvent.click(
    within(view.container.querySelector('.codepro-turn-history') as HTMLElement).getByRole(
      'button',
      { expanded: false }
    )
  );
  expect(screen.getByRole('button', { name: 'Code review started working' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Code review ended' })).toBeVisible();
  expect(view.container.querySelectorAll('[data-subagent-avatar="native-child"]')).toHaveLength(2);
});

describe('work / answer presentation boundary', () => {
  it.each([
    { earlierText: true, finalText: false, notice: true },
    { earlierText: false, finalText: false, notice: true },
    { earlierText: true, finalText: true, notice: false },
    { earlierText: false, finalText: undefined, notice: true },
    { earlierText: true, finalText: undefined, notice: false },
  ])(
    'reports a missing reply without promoting reasoning: %o',
    ({ earlierText, finalText, notice }) => {
      const thought: Message = {
        ...message(2),
        content: [
          {
            type: 'thinking',
            thinking: 'Private reasoning with <|close|>message<|sep|>.',
            signature: '',
          },
        ],
      };
      const terminal = terminalMessage('not_available', { askUser: true });
      terminal.content = terminal.content.map((content) =>
        content.type === 'systemNotification' && isTurnTerminalRecord(content.data)
          ? {
              ...content,
              data: {
                ...content.data,
                status: 'completed',
                visible_text_available: earlierText || finalText === true,
                ...(finalText === undefined ? {} : { last_response_text_available: finalText }),
                report: { ...content.data.report!, outcome: 'completed', recovery_action: 'none' },
              },
            }
          : content
      );
      const trace = [
        sourceUserMessage,
        ...(earlierText
          ? [{ ...message(1), content: [{ type: 'text' as const, text: 'Earlier progress.' }] }]
          : []),
        thought,
        ...(finalText === true
          ? [{ ...message(3), content: [{ type: 'text' as const, text: 'Final reply.' }] }]
          : []),
        terminal,
      ];
      const original = JSON.stringify(trace);
      render(show(trace, false), { wrapper: IntlTestWrapper });
      const missingReply = screen.queryByText(/The model response ended without a final reply/);
      expect(missingReply !== null).toBe(notice);
      if (missingReply) expect(missingReply).toBeVisible();
      expect(screen.queryByText(/Private reasoning with/)).not.toBeInTheDocument();
      expect(screen.queryByText('FAIL')).not.toBeInTheDocument();
      expect(screen.queryByText('PASS')).not.toBeInTheDocument();
      expect(JSON.stringify(trace)).toBe(original);
      if (earlierText) expect(screen.getByText('Earlier progress.')).toBeVisible();
      if (finalText) expect(screen.getByText('Final reply.')).toBeVisible();
    }
  );

  it.each(['error', 'missing'] as const)(
    'does not label %s tool evidence successful just because Harness completed the turn',
    async (result) => {
      const request = toolTransportMessage(2, 'declined-read', 'request');
      const response = toolTransportMessage(3, 'declined-read', 'response');
      response.content = [
        {
          type: 'toolResponse',
          id: 'declined-read',
          toolResult: { status: 'error', error: 'Tool execution was declined.' },
        },
      ];
      const terminal = terminalMessage('not_available');
      terminal.content = terminal.content.map((content) =>
        content.type === 'systemNotification' && isTurnTerminalRecord(content.data)
          ? {
              ...content,
              data: {
                ...content.data,
                session_id: 'phase-session',
                status: 'completed',
                visible_text_available: true,
              },
            }
          : content
      );
      const answer = {
        ...message(4),
        content: [{ type: 'text' as const, text: 'Read was not approved.' }],
      };
      render(
        show(
          [sourceUserMessage, request, ...(result === 'error' ? [response] : []), answer, terminal],
          false
        ),
        { wrapper: IntlTestWrapper }
      );
      await screen.findByText('Read was not approved.');
      expect(screen.queryByText('Completed 1 operations')).not.toBeInTheDocument();
      const history = screen.getByRole('button', { name: 'Time spent 3 min 24 sec' });
      expect(history).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(history);
      const tool = screen.getByRole('button', {
        name:
          result === 'error'
            ? /Read file README.md.*Unsuccessful/
            : /Read file README.md.*Unknown status/,
      });
      expect(tool).toBeVisible();
      expect(tool.querySelector('[data-tool-call-id="declined-read"]')).toHaveAttribute(
        'data-tool-phase',
        result === 'error' ? 'error' : 'unknown'
      );
      if (result === 'error') {
        fireEvent.click(tool);
        expect(
          within(screen.getByRole('region', { name: 'Execution result' })).getByText(
            'Tool execution was declined.'
          )
        ).toBeVisible();
      }
      expect(screen.queryByText('Tool call completed')).not.toBeInTheDocument();
    }
  );
  it.each(['separate', 'answer'] as const)(
    'keeps %s reasoning in manually readable work history for a completed ordinary answer',
    async (location) => {
      const thought: Message = {
        ...message(2),
        id: 'ordinary-thought',
        content: [
          { type: 'thinking', thinking: 'Consider the greeting without any tools.', signature: '' },
        ],
      };
      const answer: Message = {
        ...message(3),
        content: [
          ...(location === 'answer' ? thought.content : []),
          { type: 'text', text: 'Hello, how can I help?' },
        ],
      };
      const terminal = terminalMessage('not_available');
      terminal.content = terminal.content.map((content) =>
        content.type === 'systemNotification' && isTurnTerminalRecord(content.data)
          ? {
              ...content,
              data: {
                ...content.data,
                session_id: 'phase-session',
                status: 'completed',
                tool_action_count: 0,
                visible_text_available: true,
              },
            }
          : content
      );
      const trace = [
        sourceUserMessage,
        ...(location === 'separate' ? [thought] : []),
        answer,
        terminal,
      ];
      const view = render(show(trace, false), { wrapper: IntlTestWrapper });
      expect(await screen.findByText('Hello, how can I help?')).toBeVisible();
      const history = screen.getByRole('button', { name: 'Time spent 3 min 24 sec' });
      expect(history).toHaveAttribute('aria-expanded', 'false');
      expect(
        screen.queryByText('Consider the greeting without any tools.')
      ).not.toBeInTheDocument();
      expect(screen.queryByText('Completed 0 operations')).not.toBeInTheDocument();
      fireEvent.click(history);
      fireEvent.click(screen.getByRole('button', { name: 'Thinking' }));
      expect(screen.getByText('Consider the greeting without any tools.')).toBeVisible();
      view.rerender(
        show(
          [...JSON.parse(JSON.stringify(trace)), { ...sourceUserMessage, id: 'next-user' }],
          true
        )
      );
      expect(history).toHaveAttribute('aria-expanded', 'true');
      expect(view.container.querySelector('.codepro-turn-history')).not.toBeNull();
      expect(screen.getByText('Consider the greeting without any tools.')).toBeVisible();
      expect(screen.getByText('Hello, how can I help?')).toBeVisible();
    }
  );
  it('transports and replays a presentation boundary without sealing the prompt', () => {
    const state: AdapterState = { messages: [], localSteerTextByMessageId: new Map() };
    const data = {
      type: 'codepro_response_phase',
      schema_version: 1,
      event_type: 'response_phase',
      event_id: 'transport-phase',
      session_id: 'phase-session',
      run_id: 'run-1',
      source_user_message_id: 'source-user',
      phase: 'answer',
      created_at: 200,
    };
    const notification = {
      sessionId: 'phase-session',
      update: {
        sessionUpdate: 'status_message' as const,
        status: { type: 'progress' as const, message: '', data },
      },
    };
    const changes = applyGooseSessionNotification(state, notification);
    expect(changes.every((change) => change.type === 'messages')).toBe(true);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].created).toBe(200);
    expect(state.messages[0].content[0]).toMatchObject({
      notificationType: 'progressMessage',
      data,
    });
    applyGooseSessionNotification(state, notification, true);
    expect(state.messages).toHaveLength(1);
    applyGooseSessionNotification(state, {
      ...notification,
      update: {
        ...notification.update,
        status: {
          ...notification.update.status,
          data: { ...data, event_id: 'foreign', session_id: 'foreign-session' },
        },
      },
    });
    expect(state.messages).toHaveLength(1);
  });
  const stage = {
    ...message(201),
    content: [{ type: 'text' as const, text: 'Checking the saved changes.' }],
  };
  const answer = {
    ...message(202),
    content: [{ type: 'text' as const, text: 'The result and its limitations.' }],
  };
  const boundary = (source = 'source-user', session = 'phase-session'): Message => ({
    ...message(200),
    content: [
      {
        type: 'systemNotification',
        notificationType: 'progressMessage',
        msg: '',
        data: {
          type: 'codepro_response_phase',
          schema_version: 1,
          event_type: 'response_phase',
          event_id: 'answer-1',
          session_id: session,
          run_id: 'run-1',
          source_user_message_id: source,
          phase: 'answer',
          created_at: 200,
        },
      },
    ],
    metadata: { userVisible: true, agentVisible: false },
  });
  const work = [
    sourceUserMessage,
    stage,
    toolTransportMessage(190, 'read-before-answer', 'request'),
    toolTransportMessage(191, 'read-before-answer', 'response'),
  ];
  const show = (messages: Message[], streaming = true, activeRunId = 'run-1') => (
    <ProgressiveMessageList
      messages={messages}
      sessionType="code_pro"
      chat={{ sessionId: 'phase-session' }}
      activeRunId={activeRunId}
      isUserMessage={(message) => message.role === 'user'}
      isStreamingMessage={streaming}
    />
  );

  it('keeps live work visible, then folds it while the answer is still streaming', async () => {
    const view = render(show(work), { wrapper: IntlTestWrapper });
    expect(screen.getByText('Checking the saved changes.')).toBeVisible();
    view.rerender(show([...work, boundary(), answer]));
    await waitFor(() =>
      expect(screen.queryByText('Checking the saved changes.')).not.toBeInTheDocument()
    );
    expect(
      await screen.findByText(
        (_, element) =>
          element?.tagName === 'P' && element.textContent === 'The result and its limitations.',
        {},
        { timeout: 3000 }
      )
    ).toBeVisible();
    const toggle = view.container.querySelector('.codepro-turn-history button')!;
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getByText('Checking the saved changes.')).toBeVisible();
    view.rerender(
      show([
        ...work,
        boundary(),
        {
          ...answer,
          content: [{ type: 'text', text: 'The result and its limitations. More tokens.' }],
        },
      ])
    );
    expect(
      await screen.findByText(
        (_, element) =>
          element?.tagName === 'P' &&
          element.textContent === 'The result and its limitations. More tokens.',
        {},
        { timeout: 3000 }
      )
    ).toBeVisible();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('folds host-bound work even when it contains no tool calls', async () => {
    const view = render(show([sourceUserMessage, stage, boundary(), answer]), {
      wrapper: IntlTestWrapper,
    });
    expect(view.container.querySelector('.codepro-turn-history')).not.toBeNull();
    await waitFor(() =>
      expect(screen.queryByText('Checking the saved changes.')).not.toBeInTheDocument()
    );
    expect(
      await screen.findByText(
        (_, element) =>
          element?.tagName === 'P' && element.textContent === 'The result and its limitations.',
        {},
        { timeout: 3000 }
      )
    ).toBeVisible();
  });

  it.each(['cancelled', 'failed', 'interrupted'] as const)(
    'folds work at a bound %s receipt, including before the first tool and during stream teardown',
    async (status) => {
      const terminal = terminalMessage('not_available');
      terminal.content = terminal.content.map((content) =>
        content.type === 'systemNotification' && isTurnTerminalRecord(content.data)
          ? { ...content, data: { ...content.data, session_id: 'phase-session', status } }
          : content
      );
      terminal.content.push({ type: 'text', text: 'Stopped here; verification is incomplete.' });
      const trace = [sourceUserMessage, stage, terminal];
      const view = render(show(trace), { wrapper: IntlTestWrapper });
      expect(view.container.querySelector('.codepro-turn-history button')).toHaveAttribute(
        'aria-expanded',
        'false'
      );
      await waitFor(() =>
        expect(screen.queryByText('Checking the saved changes.')).not.toBeInTheDocument()
      );
      expect(
        await screen.findByText(
          (_, element) =>
            element?.tagName === 'P' &&
            element.textContent === 'Stopped here; verification is incomplete.',
          {},
          { timeout: 3000 }
        )
      ).toBeVisible();
      // A real call before the terminal must not require a separate answer-phase event.
      view.rerender(show([...work, terminal]));
      await waitFor(() =>
        expect(screen.queryByText('Checking the saved changes.')).not.toBeInTheDocument()
      );
      view.rerender(show(JSON.parse(JSON.stringify(trace)), false));
      const toggle = view.container.querySelector('.codepro-turn-history button')!;
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(toggle);
      expect(screen.getByText('Checking the saved changes.')).toBeVisible();
      expect(
        await screen.findByText(
          (_, element) =>
            element?.tagName === 'P' &&
            element.textContent === 'Stopped here; verification is incomplete.',
          {},
          { timeout: 3000 }
        )
      ).toBeVisible();
    }
  );

  it('does not let an older terminal hide an active run or a later tool request', () => {
    const terminal = terminalMessage('not_available');
    terminal.content = terminal.content.map((content) =>
      content.type === 'systemNotification' && isTurnTerminalRecord(content.data)
        ? { ...content, data: { ...content.data, session_id: 'phase-session' } }
        : content
    );
    const view = render(show([...work, terminal], true, 'new-run'), {
      wrapper: IntlTestWrapper,
    });
    expect(view.container.querySelector('.codepro-turn-history')).toBeNull();
    view.rerender(show([...work, terminal, toolTransportMessage(210, 'later', 'request')]));
    expect(view.container.querySelector('.codepro-turn-history')).toBeNull();
  });

  it.each([
    ['different-user', 'phase-session'],
    ['source-user', 'different-session'],
  ])('does not fold for a boundary belonging to %s / %s', (source, session) => {
    const view = render(show([...work, boundary(source, session), answer]), {
      wrapper: IntlTestWrapper,
    });
    expect(view.container.querySelector('.codepro-turn-history')).toBeNull();
    expect(screen.getByText('Checking the saved changes.')).toBeVisible();
  });

  it('does not infer an answer boundary from done prose or idle transport', () => {
    const view = render(show([...work, answer], false), { wrapper: IntlTestWrapper });
    expect(view.container.querySelector('.codepro-turn-history')).toBeNull();
    expect(screen.getByText('Checking the saved changes.')).toBeVisible();
  });

  it('ignores a stale answer boundary when the host identifies a different active run', () => {
    const view = render(show([...work, boundary(), answer], true, 'run-2'), {
      wrapper: IntlTestWrapper,
    });
    expect(view.container.querySelector('.codepro-turn-history')).toBeNull();
    expect(screen.getByText('Checking the saved changes.')).toBeVisible();
  });

  it('reopens execution presentation if an actual later tool request arrives', () => {
    const view = render(
      show([...work, boundary(), answer, toolTransportMessage(210, 'later-action', 'request')]),
      { wrapper: IntlTestWrapper }
    );
    expect(view.container.querySelector('.codepro-turn-history')).toBeNull();
    expect(screen.getByText('Checking the saved changes.')).toBeVisible();
  });

  it('does not hide a new queued user input based on the steer flag alone', async () => {
    const steer = {
      ...sourceUserMessage,
      id: 'steer-user',
      metadata: { ...sourceUserMessage.metadata, steer: true },
    };
    const view = render(show([...work, steer, boundary(), answer]), { wrapper: IntlTestWrapper });
    expect(view.container.querySelectorAll('.codepro-turn-history')).toHaveLength(0);
    expect(screen.getByText('Checking the saved changes.')).toBeVisible();
    expect(
      await screen.findByText(
        (_, element) =>
          element?.tagName === 'P' && element.textContent === 'The result and its limitations.',
        {},
        { timeout: 3000 }
      )
    ).toBeVisible();
  });

  it('replays the same presentation without treating the boundary as a terminal', () => {
    const trace = JSON.parse(JSON.stringify([...work, boundary(), answer])) as Message[];
    const view = render(show(trace, false), { wrapper: IntlTestWrapper });
    expect(view.container.querySelector('.codepro-turn-history button')).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === 'P' && element.textContent === 'The result and its limitations.'
      )
    ).toBeVisible();
    expect(screen.queryByText('Completed 1 operations')).not.toBeInTheDocument();
  });
});

describe('CodePro ordinary tool message presentation', () => {
  it('moves from live thinking to file generation without leaving an updating thought badge', () => {
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'performance',
        'requestAnimationFrame',
        'cancelAnimationFrame',
      ],
    });
    try {
      const thought: Message = {
        ...message(1),
        id: 'live-thought',
        content: [
          { type: 'thinking', thinking: 'Inspecting the requested project.', signature: '' },
        ],
      };
      const preview: Message = {
        ...message(2),
        id: 'preview',
        content: [
          {
            type: 'toolRequest',
            id: 'write-preview',
            toolCall: {
              status: 'success',
              value: {
                name: 'write',
                arguments: { path: 'app.js', content: 'one\ntwo\n', __inputPreview: true },
              },
            },
          },
        ],
      };
      const show = (generating: boolean) => (
        <ProgressiveMessageList
          messages={generating ? [thought, preview] : [thought]}
          sessionType="code_pro"
          chat={{ sessionId: 'live-progress' }}
          isUserMessage={() => false}
          isStreamingMessage
          activeToolCallIds={generating ? ['write-preview'] : []}
          thinkingActivity={
            generating ? undefined : { messageId: 'live-thought', receivedAt: Date.now() }
          }
        />
      );
      const view = render(show(false), { wrapper: IntlTestWrapper });
      expect(screen.getByRole('button', { name: 'Thinking · Updating' })).toHaveAttribute(
        'aria-expanded',
        'true'
      );
      view.rerender(show(true));
      expect(screen.getByRole('button', { name: 'Thinking' })).toHaveAttribute(
        'aria-expanded',
        'false'
      );
      act(() => vi.advanceTimersByTime(1000));
      expect(
        screen.getByText('Generating app.js · 2 lines received — not saved yet')
      ).toBeVisible();
      expect(screen.queryByText('Wrote file app.js')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(['code_pro', 'sub_agent', 'user'] as const)(
    'keeps compact history and expanded details stable when loading resolves to %s',
    (sessionType) => {
      const messages = [
        toolTransportMessage(1, 'hydrating-call-' + sessionType, 'request'),
        toolTransportMessage(2, 'hydrating-call-' + sessionType, 'response'),
      ];
      const props = {
        messages,
        chat: { sessionId: 'hydrating-' + sessionType },
        isUserMessage: (item: Message) => item.role === 'user',
      };
      const view = render(<ProgressiveMessageList {...props} />, { wrapper: IntlTestWrapper });
      const toggle = screen.getByRole('button', {
        name: 'Read file README.md Tool call completed',
      });
      const file = screen.getByRole('button', { name: 'README.md' });
      expect(toggle.contains(file)).toBe(false);
      const group = toggle.closest('[data-testid="message-container"]')!;
      fireEvent.click(toggle);
      const before = group.innerHTML;
      view.rerender(<ProgressiveMessageList {...props} sessionType={sessionType} />);
      expect(screen.getByRole('button', { name: 'Read file README.md Tool call completed' })).toBe(
        toggle
      );
      expect(screen.getByRole('button', { name: 'README.md' })).toBe(file);
      expect(toggle.querySelector('[data-tool-call-id]')).toHaveAttribute(
        'data-tool-phase',
        'success'
      );
      expect(group.innerHTML).toBe(before);
      expect(group.querySelector('button')).toHaveAttribute('aria-expanded', 'true');
    }
  );

  it('hides successful internal routing cards over ACP but preserves distinct failed events', () => {
    const props = {
      sessionType: 'code_pro' as const,
      chat: { sessionId: 'strategy' },
      isUserMessage: (item: Message) => item.role === 'user',
    };
    const event = activity({
      event_type: 'strategy_selected',
      status: 'completed',
      title: 'Routing bookkeeping',
    });
    const state: AdapterState = { messages: [], localSteerTextByMessageId: new Map() };
    const receive = (data: ActivityEvent) =>
      applyGooseSessionNotification(state, {
        sessionId: data.session_id,
        update: {
          sessionUpdate: 'status_message',
          status: { type: 'progress', message: data.title, data },
        },
      });
    receive(event);
    const view = render(<ProgressiveMessageList {...props} messages={[...state.messages]} />, {
      wrapper: IntlTestWrapper,
    });
    expect(screen.queryByTestId('message-container')).not.toBeInTheDocument();
    receive({ ...event, event_id: 'failed-event', status: 'failed' });
    expect(state.messages).toHaveLength(2);
    view.rerender(<ProgressiveMessageList {...props} messages={[...state.messages]} />);
    expect(screen.getByTestId('message-container')).toBeInTheDocument();
  });
  it.each([false, true])(
    'separates internal checks from action counts, accepted later: %s',
    (accepted) => {
      // 20261008_20: two rejected coverage submissions, then an accepted submission.
      // No error-text matching: the same presentation also applies to an unrecovered rejection.
      const calls = [
        {
          id: 'call_38st80zs',
          name: 'task_contract',
          operation: 'propose_coverage',
          error: 'no selected successful action changed target; duplicate requirement coverage',
        },
        {
          id: 'call_pk85na9t',
          name: 'task_contract',
          operation: 'propose_coverage',
          error: 'duplicate requirement coverage',
        },
        ...(accepted
          ? [
              {
                id: 'call_u3mas6qd',
                name: 'task_contract',
                operation: 'propose_coverage',
                error: '',
              },
            ]
          : []),
        {
          id: 'real-shell-failure',
          name: 'developer__shell',
          operation: '',
          error: 'test process exited 1',
        },
      ];
      const trace = calls.flatMap((call, index): Message[] => [
        {
          ...toolTransportMessage(index * 2, call.id, 'request'),
          content: [
            {
              type: 'toolRequest',
              id: call.id,
              toolCall: {
                status: 'success',
                value: {
                  name: call.name,
                  arguments: { operation: call.operation },
                },
              },
            },
          ],
        },
        {
          ...toolTransportMessage(index * 2 + 1, call.id, 'response'),
          content: [
            {
              type: 'toolResponse',
              id: call.id,
              toolResult: call.error
                ? { status: 'error', error: call.error }
                : {
                    status: 'success',
                    value: {
                      content: [
                        { type: 'text', text: '{"status":"completion_accepted","completed":true}' },
                      ],
                    },
                  },
            },
          ],
        },
      ]);
      render(
        <ProgressiveMessageList
          messages={trace}
          sessionType="code_pro"
          chat={{ sessionId: `check-history-${accepted}` }}
          isUserMessage={(item) => item.role === 'user'}
        />,
        { wrapper: IntlTestWrapper }
      );
      const group = screen.getByRole('button', {
        name: new RegExp(`^Task check records ${accepted ? 3 : 2}$`),
      });
      expect(group).toHaveAttribute('aria-expanded', 'false');
      expect(group).not.toHaveTextContent('unsuccessful');
      expect(screen.queryByText(/Completed .*other operation/)).not.toBeInTheDocument();
      fireEvent.click(group);
      const rejections = screen.getAllByRole('button', {
        name: /Check delivery evidence\s*Not accepted · view details/,
      });
      expect(rejections).toHaveLength(2);
      fireEvent.click(rejections[1]);
      expect(
        within(screen.getByRole('region', { name: 'Execution result' })).getByText(
          'duplicate requirement coverage'
        )
      ).toBeVisible();
      expect(screen.getByText('Unsuccessful')).toBeVisible();
    }
  );

  // EDU-0924-1125: ordinary Change traffic uses wrapped toolCall/toolResult,
  // not ActivityEvent. Keep its request identities and envelope shape; shorten
  // the todo/tree payloads and remove local paths from this replay fixture.
  const changeTrace: Message[] = [
    {
      ...toolTransportMessage(1, 'call_1sa30kcc', 'request'),
      content: [
        {
          type: 'toolRequest',
          id: 'call_1sa30kcc',
          toolCall: {
            status: 'success',
            value: { name: 'todo__todo_write', arguments: { content: '- [ ] Inspect enrollment' } },
          },
        },
      ],
    },
    {
      ...toolTransportMessage(2, 'call_1sa30kcc', 'response'),
      content: [
        {
          type: 'toolResponse',
          id: 'call_1sa30kcc',
          toolResult: {
            status: 'success',
            value: {
              isError: false,
              content: [],
              structuredContent: {
                codepro_plan: {
                  binding: {
                    session_id: 'ordinary-change',
                    run_id: 'run-edu',
                    requirement_revision: 1,
                  },
                  request_id: 'call_1sa30kcc',
                  content: '- [-] Build backend\n- [ ] Build frontend',
                },
              },
            },
          },
        },
      ],
    },
    {
      ...toolTransportMessage(3, 'call_xaav2ft9', 'request'),
      content: [
        {
          type: 'toolRequest',
          id: 'call_xaav2ft9',
          toolCall: {
            status: 'success',
            value: { name: 'tree', arguments: { path: 'fixture', depth: 3 } },
          },
        },
      ],
    },
    toolTransportMessage(4, 'call_xaav2ft9', 'response'),
    toolTransportMessage(5, 'read-followup', 'request'),
    toolTransportMessage(6, 'read-followup', 'response'),
  ] as Message[];

  const renderTrace = (messages: Message[], active: string[] = []) => (
    <ProgressiveMessageList
      messages={messages}
      sessionType="code_pro"
      chat={{ sessionId: 'ordinary-change' }}
      isUserMessage={(item) => item.role === 'user'}
      isStreamingMessage={active.length > 0}
      activeToolCallIds={active}
      maxVisibleMessages={400}
      showLoadingThreshold={400}
    />
  );

  it('[retest-20261016] keeps whitespace and thinking between tool batches in one live collapsible group', async () => {
    const first = toolTransportMessage(1, 'first-batch', 'request');
    first.content.push({ type: 'text', text: '  \n ' });
    const thinking: Message = {
      ...message(3),
      content: [
        { type: 'thinking', thinking: 'Checking the next files.', signature: '' },
        { type: 'text', text: '' },
      ],
    };
    const records = [
      first,
      toolTransportMessage(2, 'first-batch', 'response'),
      thinking,
      toolTransportMessage(4, 'second-batch', 'request'),
    ];
    const view = render(renderTrace(records, ['second-batch']), { wrapper: IntlTestWrapper });
    expect(screen.getAllByTestId('tool-message-group')).toHaveLength(1);
    const toggle = screen.getByRole('button', { name: 'Work history 2 operations' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    view.rerender(
      renderTrace(
        [
          first,
          toolTransportMessage(2, 'first-batch', 'response'),
          message(3),
          toolTransportMessage(4, 'second-batch', 'request'),
        ],
        ['second-batch']
      )
    );
    await waitFor(() => expect(screen.getAllByTestId('tool-message-group')).toHaveLength(2));
    expect(screen.getByText('message 3')).toBeVisible();
  });

  it('does not split tools at invisible host plan updates or standalone whitespace', () => {
    const context: Message = {
      ...message(3),
      content: [
        {
          type: 'systemNotification',
          notificationType: 'progressMessage',
          msg: '',
          data: {
            type: 'codepro_plan_context',
            schema_version: 1,
            event_id: 'between-reads',
            session_id: 'ordinary-change',
            selected: {
              session_id: 'ordinary-change',
              run_id: 'run',
              requirement_revision: 1,
            },
            plan: null,
          },
        },
      ],
    };
    const records = [
      toolTransportMessage(1, 'read-one', 'request'),
      toolTransportMessage(2, 'read-one', 'response'),
      context,
      { ...message(4), content: [{ type: 'text' as const, text: '  \n ' }] },
      toolTransportMessage(5, 'read-two', 'request'),
    ];
    render(renderTrace(records, ['read-two']), { wrapper: IntlTestWrapper });
    expect(screen.getAllByTestId('tool-message-group')).toHaveLength(1);
  });

  it('[retest-20261016] hides successful agent discovery while retaining public prose, pending calls and errors', async () => {
    const request: Message = {
      ...toolTransportMessage(1, 'agent-status', 'request'),
      content: [
        {
          type: 'toolRequest',
          id: 'agent-status',
          toolCall: { name: 'list_agents', arguments: {} },
        },
        { type: 'text', text: 'Public progress stays visible.' },
      ],
    };
    const success = toolTransportMessage(2, 'agent-status', 'response');
    const view = render(renderTrace([request, success]), { wrapper: IntlTestWrapper });
    expect(screen.getByText('Public progress stays visible.')).toBeVisible();
    expect(view.container.querySelectorAll('.goose-message-tool')).toHaveLength(0);
    view.rerender(renderTrace([{ ...request, content: request.content.slice(0, 1) }, success]));
    expect(view.container.querySelectorAll('.goose-message-tool')).toHaveLength(0);
    expect(screen.queryByText('Public progress stays visible.')).toBeNull();
    view.rerender(renderTrace([request], ['agent-status']));
    await waitFor(() =>
      expect(view.container.querySelectorAll('.goose-message-tool')).toHaveLength(1)
    );
    const failure: Message = {
      ...success,
      content: [
        {
          type: 'toolResponse',
          id: 'agent-status',
          toolResult: { status: 'error', error: 'Fixture status lookup failed' },
        },
      ],
    };
    view.rerender(renderTrace([request, failure]));
    expect(view.container.querySelectorAll('.goose-message-tool')).toHaveLength(1);
    expect(screen.getByText('Public progress stays visible.')).toBeVisible();
  });

  it('reuses a host-bound plan across inputs, isolates new tasks and stops animation while idle', () => {
    const activePlan = { ...changeTrace[0] };
    activePlan.content = [
      {
        type: 'toolRequest',
        id: 'call_1sa30kcc',
        toolCall: {
          status: 'success',
          value: {
            name: 'todo__todo_write',
            arguments: {
              content: '- [-] Build backend\n- [ ] Build frontend',
            },
          },
        },
      },
    ];
    const context: Message = {
      ...message(0),
      content: [
        {
          type: 'systemNotification',
          notificationType: 'progressMessage',
          msg: '',
          data: {
            type: 'codepro_plan_context',
            schema_version: 1,
            event_id: 'select-edu',
            session_id: 'ordinary-change',
            selected: { session_id: 'ordinary-change', run_id: 'run-edu', requirement_revision: 1 },
            plan: null,
          },
        },
      ],
    };
    const trace = [sourceUserMessage, context, activePlan];
    const dock = (messages: Message[], running = true, activeRunId = 'run-edu') => (
      <CodeProPlanDock
        sessionId="ordinary-change"
        activeRunId={activeRunId}
        messages={messages}
        running={running}
      />
    );
    const view = render(dock(trace), { wrapper: IntlTestWrapper });
    expect(screen.queryByTestId('plan-dock')).not.toBeInTheDocument();
    trace.push(changeTrace[1]);
    view.rerender(dock([...trace]));
    const plan = screen.getByTestId('work-plan');
    expect(plan).not.toHaveAttribute('open');
    expect(plan.querySelector('[aria-label="In progress"]')).not.toBeNull();
    expect(plan.querySelectorAll('.animate-spin')).toHaveLength(1);
    view.rerender(dock([...trace], false));
    expect(plan.querySelectorAll('.animate-spin')).toHaveLength(0);
    view.rerender(dock([...trace, { ...sourceUserMessage, id: 'next-turn' }]));
    expect(plan.querySelectorAll('.animate-spin')).toHaveLength(1);
    view.rerender(dock(trace, true, 'question-prompt'));
    expect(plan.querySelectorAll('.animate-spin')).toHaveLength(0);
    const newTask: Message = {
      ...context,
      content: [
        {
          type: 'systemNotification',
          notificationType: 'progressMessage',
          msg: '',
          data: {
            type: 'codepro_plan_context',
            schema_version: 1,
            event_id: 'select-app',
            session_id: 'ordinary-change',
            selected: { session_id: 'ordinary-change', run_id: 'run-app', requirement_revision: 1 },
            plan: null,
          },
        },
      ],
    };
    view.rerender(dock([...trace, newTask, changeTrace[1]], true, 'run-app'));
    expect(screen.queryByTestId('plan-dock')).not.toBeInTheDocument();
  });

  it('shows action labels and preserves detail expansion on live input and history replay', () => {
    const view = render(renderTrace(changeTrace), { wrapper: IntlTestWrapper });
    const group = compactGroups()[0];
    expect(screen.queryByTestId('work-plan')).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Completed 1 operation Read 1 file' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(group.querySelector('.codepro-operation-details')).toHaveClass(
      'codepro-operation-details'
    );
    view.rerender(renderTrace(JSON.parse(JSON.stringify(changeTrace))));
    expect(compactGroups()[0].querySelector('button')).toHaveAttribute('aria-expanded', 'true');
    expect(group.querySelectorAll('.goose-message-tool')).toHaveLength(2);
    expect(screen.queryByText(/Tool records 2/)).not.toBeInTheDocument();
    view.unmount();
    render(renderTrace(JSON.parse(JSON.stringify(changeTrace))), { wrapper: IntlTestWrapper });
    expect(compactGroups()[0].querySelector('button')).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps public stage text, failed calls and the active command outside folded history', () => {
    const stage = {
      ...message(5),
      content: [
        { type: 'text', text: 'I found the configuration issue; next I will validate it.' },
      ],
    } as Message;
    const privateThinking = {
      ...message(5),
      id: 'private-thought',
      content: [
        { type: 'thinking', thinking: 'private reasoning must not be shown', signature: '' },
      ],
    } as Message;
    const failed = toolTransportMessage(7, 'failed-call', 'response');
    failed.content = [
      {
        type: 'toolResponse',
        id: 'failed-call',
        toolResult: { status: 'error', error: 'Permission rejected' },
      },
    ];
    const running = toolTransportMessage(8, 'running-call', 'request');
    running.content = [
      {
        type: 'toolRequest',
        id: 'running-call',
        toolCall: {
          status: 'success',
          value: { name: 'developer__shell', arguments: { command: 'npm.cmd test' } },
        },
      },
    ];
    render(
      renderTrace(
        [
          ...changeTrace,
          privateThinking,
          stage,
          toolTransportMessage(6, 'failed-call', 'request'),
          failed,
          running,
        ],
        ['running-call']
      ),
      { wrapper: IntlTestWrapper }
    );
    expect(
      screen.getByText(stage.content[0].type === 'text' ? stage.content[0].text : '')
    ).toBeVisible();
    expect(screen.queryByText('private reasoning must not be shown')).not.toBeInTheDocument();
    expect(screen.queryByText('npm.cmd test')).not.toBeInTheDocument();
    expect(screen.queryByText('Permission rejected')).not.toBeInTheDocument();
    expect(screen.getByText('Unsuccessful')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Run command/ }));
    expect(screen.getByText('npm.cmd test')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Completed 1 operation Read 1 file' })
    ).toHaveAttribute('aria-expanded', 'false');
    expect(compactGroups()).toHaveLength(2);
  });

  it('shows a hundred action labels in one bounded scroll region without opening code', () => {
    const records = Array.from({ length: 100 }, (_, index) => [
      toolTransportMessage(index * 2, `read-${index}`, 'request'),
      toolTransportMessage(index * 2 + 1, `read-${index}`, 'response'),
    ]).flat();
    render(renderTrace(records), { wrapper: IntlTestWrapper });
    const toggle = screen.getByRole('button', { name: 'Read 1 file' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    const region = compactGroups()[0].querySelector('.codepro-operation-details')!;
    expect(region).toHaveClass('codepro-operation-details');
    expect(region.querySelectorAll('.goose-message-tool')).toHaveLength(100);
    expect(region.querySelector('[aria-expanded="true"]')).toBeNull();
  });
});

describe('ProgressiveMessageList TurnTerminal retry actions', () => {
  it.each(['cancelled', 'interrupted'] as const)(
    'keeps a plain %s receipt in history without a separate host chat row',
    (status) => {
      const terminal = terminalMessage('not_available');
      terminal.content = terminal.content.map((content) =>
        content.type === 'systemNotification' && isTurnTerminalRecord(content.data)
          ? { ...content, data: { ...content.data, status } }
          : content
      );
      const trace = [sourceUserMessage, terminal];
      const original = JSON.stringify(trace);
      const view = render(
        <ProgressiveMessageList
          messages={trace}
          chat={{ sessionId: 'terminal-session' }}
          isUserMessage={(item) => item.role === 'user'}
        />,
        { wrapper: IntlTestWrapper }
      );
      expect(screen.queryByText('Stopped')).not.toBeInTheDocument();
      expect(screen.queryByText(/Stopped at your request/)).not.toBeInTheDocument();
      expect(screen.getAllByTestId('message-container')).toHaveLength(1);
      expect(JSON.stringify(trace)).toBe(original);

      terminal.content.push({ type: 'text', text: '已记下当前进度。' });
      view.rerender(
        <ProgressiveMessageList
          messages={[sourceUserMessage, { ...terminal }]}
          chat={{ sessionId: 'terminal-session' }}
          isUserMessage={(item) => item.role === 'user'}
        />
      );
      expect(screen.getByText('已记下当前进度。')).toBeVisible();
    }
  );

  it('shows Retry and replays the source request for an interrupted replay contract', () => {
    const onMessageUpdate = vi.fn();
    render(
      <ProgressiveMessageList
        messages={[sourceUserMessage, terminalMessage('replay_user_request')]}
        chat={{ sessionId: 'terminal-session' }}
        isUserMessage={(item) => item.role === 'user'}
        onMessageUpdate={onMessageUpdate}
      />,
      { wrapper: IntlTestWrapper }
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onMessageUpdate).toHaveBeenCalledWith(
      'terminal-replay_user_request',
      'Analyze this project',
      'replay'
    );
  });

  it('does not show Retry for AskUser plus not_available', () => {
    render(
      <ProgressiveMessageList
        messages={[sourceUserMessage, terminalMessage('not_available', { askUser: true })]}
        chat={{ sessionId: 'terminal-session' }}
        isUserMessage={(item) => item.role === 'user'}
        onMessageUpdate={vi.fn()}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('keeps checkpoint retry wired to continue', () => {
    const onMessageUpdate = vi.fn();
    render(
      <ProgressiveMessageList
        messages={[
          sourceUserMessage,
          terminalMessage('continue_checkpoint', { checkpointId: 'checkpoint-1' }),
        ]}
        chat={{ sessionId: 'terminal-session' }}
        isUserMessage={(item) => item.role === 'user'}
        onMessageUpdate={onMessageUpdate}
      />,
      { wrapper: IntlTestWrapper }
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onMessageUpdate).toHaveBeenCalledWith(
      'terminal-continue_checkpoint',
      '继续执行',
      'continue'
    );
  });
});

describe('ProgressiveMessageList retention window', () => {
  it('keeps an operation group stable across hidden messages and the pagination boundary', () => {
    const start: Message = {
      ...message(0),
      role: 'user',
      content: [{ type: 'text', text: 'Build the enrollment flow' }],
    };
    const operations = Array.from({ length: 25 }, (_, index) => [
      toolTransportMessage(index * 3 + 1, `call-${index}`, 'request'),
      { ...message(index * 3 + 2), metadata: { userVisible: false, agentVisible: true } },
      toolTransportMessage(index * 3 + 3, `call-${index}`, 'response'),
    ]).flat();
    render(
      <ProgressiveMessageList
        messages={[start, ...operations]}
        chat={{ sessionId: 'group' }}
        sessionType="code_pro"
        isUserMessage={(item) => item.role === 'user'}
        batchSize={100}
        showLoadingThreshold={0}
      />,
      { wrapper: IntlTestWrapper }
    );
    expect(compactGroups()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Read 1 file' }));
    expect(compactGroups()[0].querySelectorAll('.goose-message-tool')).toHaveLength(25);
  });

  it('loads older history on scroll without a load-more button', () => {
    const intersections: IntersectionObserverCallback[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersections.push(callback);
        }
        observe() {}
        disconnect() {}
      }
    );
    const messages = Array.from({ length: 100 }, (_, index) => message(index));

    render(
      <ProgressiveMessageList
        messages={messages}
        chat={{ sessionId: 'long-session' }}
        isUserMessage={() => false}
        batchSize={100}
        showLoadingThreshold={0}
        renderMessage={(item) => <div data-testid="rendered-message">{item.id}</div>}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.getAllByTestId('rendered-message')).toHaveLength(40);
    expect(screen.queryByText('message-59')).not.toBeInTheDocument();
    expect(screen.getByText('message-60')).toBeInTheDocument();
    expect(screen.getByText('message-99')).toBeInTheDocument();

    expect(
      screen.queryByRole('button', { name: /load earlier messages/i })
    ).not.toBeInTheDocument();
    act(() => {
      for (const callback of [...intersections]) {
        callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver
        );
      }
    });
    vi.unstubAllGlobals();

    expect(screen.getAllByTestId('rendered-message')).toHaveLength(100);
    expect(screen.getByText('message-0')).toBeInTheDocument();
  });

  it('clears development performance entries at bounded message intervals', () => {
    const clearMeasures = vi.spyOn(window.performance, 'clearMeasures');
    const clearMarks = vi.spyOn(window.performance, 'clearMarks');

    render(
      <ProgressiveMessageList
        messages={Array.from({ length: 20 }, (_, index) => message(index))}
        chat={{ sessionId: 'performance-session' }}
        isUserMessage={() => false}
        renderMessage={(item) => <div>{item.id}</div>}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(clearMeasures).toHaveBeenCalledOnce();
    expect(clearMarks).toHaveBeenCalledOnce();
  });
});

describe('ProgressiveMessageList CodePro activity orchestration', () => {
  it('groups real activity streams across represented tool transport and hides duplicate tool cards', () => {
    const messages = [
      activityMessage(
        1,
        activity({
          event_id: 'read-1',
          event_type: 'file_read',
          status: 'completed',
          path: 'D:\\project\\README.md',
          title: '已读取文件',
          finished_at: '2026-08-02T08:00:01.000Z',
        })
      ),
      toolTransportMessage(2, 'read-1', 'request'),
      toolTransportMessage(3, 'read-1', 'response'),
      {
        ...message(3),
        id: 'hidden-internal-message',
        metadata: { userVisible: false, agentVisible: true },
      },
      activityMessage(
        4,
        activity({
          event_id: 'read-2',
          event_type: 'file_read',
          status: 'completed',
          path: 'D:\\project\\app.txt',
          title: '已读取文件',
          finished_at: '2026-08-02T08:00:02.000Z',
        })
      ),
      toolTransportMessage(5, 'read-2', 'request'),
      toolTransportMessage(6, 'read-2', 'response'),
    ];

    render(
      <ProgressiveMessageList
        messages={messages}
        chat={{ sessionId: 'activity-session' }}
        isUserMessage={(item) => item.role === 'user'}
      />,
      { wrapper: IntlTestWrapper }
    );

    const timeline = screen.getByRole('button', { name: 'Operations recorded · 2 actions' });
    expect(timeline).toBeVisible();
    expect(timeline).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Read' })).not.toBeInTheDocument();
  });

  it('keeps separate tasks in the same run as separate activity timelines', () => {
    render(
      <ProgressiveMessageList
        messages={[
          activityMessage(
            1,
            activity({ event_id: 'task-1-read', task_id: 'task-1', status: 'completed' })
          ),
          activityMessage(
            2,
            activity({ event_id: 'task-2-read', task_id: 'task-2', status: 'completed' })
          ),
        ]}
        chat={{ sessionId: 'activity-session' }}
        isUserMessage={() => false}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.getAllByRole('button', { name: /^Activity:/ })).toHaveLength(2);
  });

  it('merges lifecycles and shows mixed actions in one expandable timeline without hiding failures', () => {
    const messages = [
      activityMessage(
        1,
        activity({
          event_id: 'read-1',
          event_type: 'file_read',
          path: 'D:\\project\\README.md',
        })
      ),
      activityMessage(
        2,
        activity({
          event_id: 'read-1',
          event_type: 'file_read',
          status: 'completed',
          path: 'D:\\project\\README.md',
          title: '已读取文件',
          finished_at: '2026-08-02T08:00:01.000Z',
        })
      ),
      activityMessage(
        3,
        activity({
          event_id: 'read-2',
          event_type: 'file_read',
          status: 'completed',
          path: 'D:\\project\\src\\app.ts',
          title: '已读取文件',
          finished_at: '2026-08-02T08:00:02.000Z',
        })
      ),
      activityMessage(
        4,
        activity({
          event_id: 'command-1',
          event_type: 'command_completed',
          status: 'completed',
          path: 'D:\\project',
          command_summary: 'pnpm test',
          title: '命令执行完成',
          finished_at: '2026-08-02T08:00:03.000Z',
          exit_code: 0,
        })
      ),
      activityMessage(
        5,
        activity({
          event_id: 'change-1',
          event_type: 'file_changed',
          status: 'failed',
          path: 'D:\\project\\src\\broken.ts',
          title: '文件修改失败',
          finished_at: '2026-08-02T08:00:04.000Z',
        })
      ),
    ];

    render(
      <ProgressiveMessageList
        messages={messages}
        chat={{ sessionId: 'activity-session' }}
        isUserMessage={() => false}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.getByRole('button', { name: 'Operations recorded · 4 actions' })).toBeVisible();
    expect(screen.queryByText('1 failed action')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Activity: Run pnpm test · Completed' })
    ).toBeVisible();
    expect(
      screen.getByRole('button', {
        name: 'Activity: Change D:\\project\\src\\broken.ts · Failed',
      })
    ).toBeVisible();
    expect(screen.getByRole('region', { name: 'Execution log' })).toBeVisible();
    expect(
      screen.getAllByRole('button', {
        name: 'Activity: Read D:\\project\\README.md · Completed',
      })
    ).toHaveLength(1);
    expect(
      screen.getByRole('button', {
        name: 'Activity: Read D:\\project\\src\\app.ts · Completed',
      })
    ).toBeVisible();
  });

  it('keeps the first retained activity visible at the progressive history boundary', () => {
    const messages = [
      ...Array.from({ length: 40 }, (_, index) => message(index)),
      activityMessage(
        40,
        activity({
          event_id: 'boundary-command',
          event_type: 'command_completed',
          status: 'completed',
          command_summary: 'pnpm test --filter boundary',
          finished_at: '2026-08-02T08:00:01.000Z',
        })
      ),
    ];

    render(
      <ProgressiveMessageList
        messages={messages}
        chat={{ sessionId: 'activity-session' }}
        isUserMessage={() => false}
        batchSize={100}
        showLoadingThreshold={0}
      />,
      { wrapper: IntlTestWrapper }
    );

    const timeline = screen.getByRole('button', {
      name: 'Activity: Run pnpm test --filter boundary · Completed',
    });
    expect(timeline).toBeVisible();
    expect(
      screen.getByRole('button', {
        name: 'Activity: Run pnpm test --filter boundary · Completed',
      })
    ).toBeVisible();
  });
});

describe('tool cards across active-turn notification messages', () => {
  it('tracks current tools across approval and notification messages without reviving old unknown calls', async () => {
    const old = toolTransportMessage(1, 'old-call', 'request');
    old.content = [
      {
        type: 'toolRequest',
        id: 'old-call',
        toolCall: {
          status: 'success',
          value: { name: 'read_document', arguments: { path: 'old-fixture.txt' } },
        },
      },
    ];
    const user: Message = {
      ...message(2),
      role: 'user',
      content: [{ type: 'text', text: 'Run the next task' }],
    };
    const current = toolTransportMessage(3, 'current-call', 'request');
    current.content = [
      {
        type: 'toolRequest',
        id: 'current-call',
        toolCall: {
          status: 'success',
          value: { name: 'read_document', arguments: { path: 'current-fixture.txt' } },
        },
      },
    ];
    const notice = message(4);
    const approval: Message = {
      ...message(5),
      content: [
        {
          type: 'actionRequired',
          data: {
            actionType: 'toolConfirmation',
            id: 'separate-permission-id',
            toolName: 'read_document',
            arguments: { path: 'current-fixture.txt' },
          },
        },
      ],
    };
    const card = (messages: Message[], streaming: boolean) => (
      <ProgressiveMessageList
        messages={messages}
        chat={{ sessionId: 'native-display-turn' }}
        foldTurns={false}
        isUserMessage={(item) => item.role === 'user'}
        isStreamingMessage={streaming}
        activeToolCallIds={['current-call']}
      />
    );
    const view = render(card([old, user, current, notice], true), { wrapper: IntlTestWrapper });
    expect(
      screen.getByRole('button', { name: /Read file current-fixture.txt.*Running/ })
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: /Read file old-fixture.txt.*Unknown status/ })
    ).toBeVisible();
    view.rerender(card([old, user, current, notice, approval], true));
    expect(
      screen.getByRole('button', { name: /Read file current-fixture.txt.*Running/ })
    ).toBeVisible();
    const matchingApproval: Message = {
      ...approval,
      content: [
        {
          type: 'actionRequired',
          data: {
            actionType: 'toolConfirmation',
            id: 'current-call',
            toolName: 'read_document',
            arguments: { path: 'current-fixture.txt' },
          },
        },
      ],
    };
    view.rerender(card([old, user, current, notice, matchingApproval], true));
    expect(
      screen.getByRole('button', { name: /Read file current-fixture.txt.*Running/ })
    ).toBeVisible();
    let permissionResponse: ReturnType<typeof requestAcpPermission> | undefined;
    try {
      act(() => {
        permissionResponse = requestAcpPermission({
          sessionId: 'native-display-turn',
          toolCall: {
            toolCallId: 'current-call',
            title: 'read_document',
            rawInput: { path: 'current-fixture.txt' },
          },
          options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
        });
      });
      expect(
        screen.getByRole('button', { name: /Read file current-fixture.txt.*Pending/ })
      ).toBeVisible();
      expect(
        screen.getByRole('button', { name: /Read file old-fixture.txt.*Unknown status/ })
      ).toBeVisible();
      act(() => {
        expect(
          resolveAcpPermissionRequest('native-display-turn', 'current-call', 'allow_once')
        ).toBe(true);
      });
      await expect(permissionResponse).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      });
      expect(
        screen.getByRole('button', { name: /Read file current-fixture.txt.*Running/ })
      ).toBeVisible();
      view.rerender(card([old, user, current, notice], true));
      expect(
        screen.getByRole('button', { name: /Read file current-fixture.txt.*Running/ })
      ).toBeVisible();
      const response = toolTransportMessage(6, 'current-call', 'response');
      view.rerender(card([old, user, current, notice, response], true));
      const settledTool = screen.getByRole('button', {
        name: 'Read file current-fixture.txt Tool call completed',
      });
      expect(screen.getByRole('button', { name: 'current-fixture.txt' })).toBeVisible();
      expect(settledTool).toBeVisible();
      expect(settledTool.querySelector('[data-tool-call-id="current-call"]')).toHaveAttribute(
        'data-tool-phase',
        'success'
      );
      view.rerender(card([old, user, current, notice, response], false));
      expect(
        screen
          .getByRole('button', { name: 'Read file current-fixture.txt Tool call completed' })
          .querySelector('[data-tool-call-id="current-call"]')
      ).toHaveAttribute('data-tool-phase', 'success');
      expect(
        screen.getByRole('button', { name: 'Read file current-fixture.txt Tool call completed' })
      ).toBeVisible();
      expect(screen.getByRole('button', { name: 'current-fixture.txt' })).toBeVisible();
      expect(
        screen.getByRole('button', { name: /Read file old-fixture.txt.*Unknown status/ })
      ).toBeVisible();
    } finally {
      act(() => cancelAcpPermissionRequestsForSession('native-display-turn'));
      await permissionResponse;
    }
  });
});
