import { act, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import type { Message, ToolRequestMessageContent } from '../types/message';
import ProgressiveMessageList from './ProgressiveMessageList';
import { ScrollFollowingContext } from './ui/scroll-follow-context';
import {
  requestAcpPermission,
  cancelAcpPermissionRequestsForSession,
} from '../acp/permissionRequests';

const user: Message = {
  id: 'source-user',
  role: 'user',
  created: 1,
  content: [{ type: 'text', text: 'Inspect the project.' }],
  metadata: { userVisible: true, agentVisible: true },
};
const request = (id: string): ToolRequestMessageContent => ({
  type: 'toolRequest',
  id,
  toolCall: { name: 'developer__read', arguments: { path: `${id}.md` } },
});
const assistant = (id: string, content: Message['content']): Message => ({
  id,
  role: 'assistant',
  created: 2,
  content,
  metadata: { userVisible: true, agentVisible: true },
});
const receipt = (id: string, failed = false): Message => ({
  id: `receipt-${id}`,
  role: 'user',
  created: 3,
  content: [
    {
      type: 'toolResponse',
      id,
      toolResult: failed
        ? { status: 'error', error: 'Read failed for this fixture.' }
        : { status: 'success', value: { content: [{ type: 'text', text: 'File received.' }] } },
    },
  ],
  metadata: { userVisible: false, agentVisible: true },
});
const thought = (thinking: string): Message['content'][number] => ({
  type: 'thinking',
  thinking,
  signature: '',
});
const show = (messages: Message[], streaming = false, retry = vi.fn(), following = true) => (
  <ScrollFollowingContext.Provider value={following}>
    <ProgressiveMessageList
      messages={messages}
      chat={{ sessionId: 'between-replies' }}
      isUserMessage={(item) => item.role === 'user'}
      isStreamingMessage={streaming}
      activeToolCallIds={streaming ? ['second'] : []}
      onMessageUpdate={retry}
    />
  </ScrollFollowingContext.Provider>
);
beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});
afterEach(() => cancelAcpPermissionRequestsForSession('between-replies'));

describe('processes between public replies', () => {
  it('identifies the main assistant once per reply and renders an independent project report', () => {
    const reply = assistant('reply', [{ type: 'text', text: 'I sent the task to the project.' }]);
    reply.metadata.inference = { provider: 'test', requestedModel: 'model-A', resolvedModel: 'model-A' };
    const notice = assistant('receipt', [{ type: 'systemNotification', notificationType: 'inlineMessage', msg: '', data: {
      event: 'managed_turn_result', outcome: 'completed', requestId: 'task-1', sessionId: 'plane',
      brief: { title: 'Plane', task: 'Build', result: 'Controls work.', files: [], fileCount: 0 },
    } }]);
    const { container } = render(<ProgressiveMessageList mainConversation messages={[user, reply, notice]}
      chat={{ sessionId: 'main' }} isUserMessage={m => m.role === 'user'} />, { wrapper: IntlTestWrapper });
    expect(container.querySelector('.user svg.lucide-user-round')).toBeTruthy();
    expect(screen.getAllByText('CodeBuddy')).toHaveLength(2);
    expect(screen.getByText('model-A')).toBeVisible();
    expect(screen.getByRole('article', { name: 'Project brief · Plane' }).closest('[data-chat-turn-id]')).toBeNull();
    expect(screen.getByText('Controls work.')).toBeVisible();
  });
  it.each([false, true])('shows one footer per user turn with an interruption receipt: %s', (stopped) => {
    const stage = assistant('stage', [{ type: 'text', text: 'Checking the workspace' }]);
    stage.metadata.usage = { inputTokens: 10, outputTokens: 4, totalTokens: 14 };
    const reply = assistant('reply', [{ type: 'text', text: 'Starting the server file' }]);
    reply.metadata.usage = { inputTokens: 20, outputTokens: 7, totalTokens: 27 };
    const terminal = assistant('stop', [{ type: 'systemNotification', notificationType: 'turnTerminal', msg: '',
      data: { schema_version: 1, session_id: 'between-replies', run_id: 'run', terminal_message_id: 'stop',
        source_user_message_id: user.id, status: 'interrupted', last_response_text_available: true,
        user_requested_stop: true, visible_text_available: true, tool_action_count: 1,
        checkpoint_id: null, retry_strategy: 'not_available', copy_artifact_ref: null,
        finished_at: new Date(62_000).toISOString() },
    }]);
    const { container } = render(show([user, stage, assistant('read', [request('one')]), receipt('one'),
      reply, ...(stopped ? [terminal] : [])]), { wrapper: IntlTestWrapper });
    expect(screen.getByText('Starting the server file')).toBeVisible();
    expect(screen.getByText('Output 11')).toBeVisible();
    expect(container.querySelectorAll('.codepro-message-actions')).toHaveLength(1);
    if (stopped) expect(screen.getByText('Stopped after 1 min 1 sec')).toBeVisible();
    else expect(screen.getByText('Checking the workspace')).toBeVisible();
  });
  it.each(['completed', 'cancelled'] as const)('times the active turn and freezes on %s even without tool history', (status) => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(60_000);
      const start = { ...user, created: 1 };
      const earlier = { ...user, id: 'earlier', created: 0 };
      const view = render(show([earlier, start], true), { wrapper: IntlTestWrapper });
      expect(screen.getByRole('timer')).toHaveTextContent('Working for 59 sec');
      act(() => { vi.advanceTimersByTime(2000); });
      expect(screen.getByRole('timer')).toHaveTextContent('Working for 1 min 1 sec');
      const end = assistant('end', [{
        type: 'systemNotification', notificationType: 'turnTerminal', msg: '',
        data: {
          schema_version: 1, session_id: 'between-replies', run_id: 'run',
          terminal_message_id: 'end', source_user_message_id: start.id, status,
          checkpoint_id: null, retry_strategy: 'not_available', visible_text_available: false,
          tool_action_count: 0, copy_artifact_ref: null, finished_at: new Date(62_000).toISOString(),
        },
      }]);
      view.rerender(show([earlier, start, end]));
      act(() => { vi.advanceTimersByTime(60_000); });
      expect(screen.queryByRole('timer')).toBeNull();
      expect(screen.getByText(status === 'cancelled' ? 'Stopped after 1 min 1 sec' : 'Time spent 1 min 1 sec')).toBeVisible();
    } finally { vi.useRealTimers(); }
  });
  it('does not include unbound historical receipts in the latest completed turn footer', () => {
    const answer = assistant('math-answer', [{ type: 'text', text: '899' }]);
    answer.metadata.usage = { inputTokens: 59, outputTokens: 16, totalTokens: 93389 };
    const unbound = assistant('old-missing', []);
    unbound.metadata = {
      userVisible: false,
      agentVisible: false,
      usageUnattributed: true,
      usage: { inputTokens: 65946, outputTokens: 527, totalTokens: 66473 },
    };
    const terminal = assistant('math-terminal', [
      {
        type: 'systemNotification',
        notificationType: 'turnTerminal',
        msg: '',
        data: {
          schema_version: 1,
          session_id: 'between-replies',
          run_id: 'math-run',
          terminal_message_id: 'math-terminal',
          source_user_message_id: user.id,
          status: 'completed',
          last_response_text_available: true,
          visible_text_available: true,
          tool_action_count: 0,
          checkpoint_id: null,
          retry_strategy: 'not_available',
          copy_artifact_ref: null,
          finished_at: '2026-11-01T00:00:00Z',
        },
      },
    ]);
    render(show([user, answer, terminal, unbound]), { wrapper: IntlTestWrapper });
    expect(screen.getByText('Output 16')).toBeVisible();
    expect(screen.queryByText('Output 543')).not.toBeInTheDocument();
    expect(screen.getByText(/Time spent/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /Time spent/ })).toBeNull();
    expect(screen.queryByText(/1970.*2026/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Thinking/ })).toBeNull();
    expect(screen.getByText('899')).toBeVisible();
  });

  it('keeps a length-limited terminal and its continuation outside collapsed process history', () => {
    const terminal = assistant('length-terminal', [
      {
        type: 'systemNotification',
        notificationType: 'turnTerminal',
        msg: 'Output stopped',
        data: {
          schema_version: 1,
          session_id: 'between-replies',
          run_id: 'run',
          terminal_message_id: 'length-terminal',
          source_user_message_id: user.id,
          status: 'interrupted',
          stop_reason: 'max_tokens',
          output_limit: { automaticAttempts: 1, maxAutomaticAttempts: 1 },
          checkpoint_id: null,
          retry_strategy: 'not_available',
          visible_text_available: true,
          tool_action_count: 0,
          copy_artifact_ref: null,
          finished_at: '2026-11-01T00:00:00Z',
        },
      },
    ]);
    render(
      show([
        user,
        assistant('failed-draft', [{ type: 'text', text: 'UNFINISHED_DRAFT' }]),
        terminal,
      ]),
      { wrapper: IntlTestWrapper }
    );
    expect(screen.getByText(/length limit again after one recovery attempt/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try continuing' })).toBeVisible();
  });
  it.each([false, true])(
    'summarizes closed process records even when an earlier operation was unsuccessful (all failed: %s)',
    (allFailed) => {
      const desktopRequest = (id: string): ToolRequestMessageContent => ({
        type: 'toolRequest',
        id,
        toolCall: {
          name: 'mcp__qwen_computer__get_app_state',
          arguments: { app_name: 'Example viewer' },
        },
      });
      const records = [
        user,
        assistant('failed-observation', [desktopRequest('failed')]),
        receipt('failed', true),
        ...(!allFailed
          ? [assistant('fresh-observation', [desktopRequest('fresh')]), receipt('fresh')]
          : []),
        assistant('stage-report', [
          { type: 'text', text: 'The observed files differ; I will check the remaining material.' },
        ]),
      ];
      const view = render(show(records, true), { wrapper: IntlTestWrapper });
      const group = view.container.querySelector<HTMLElement>('[data-process-group]')!;
      const header = group.querySelector('.codepro-group-heading')!.closest('button')!;
      expect(header).toHaveTextContent(allFailed ? 'Tool records 1' : 'Completed 1 operation');
      expect(header).not.toHaveTextContent('Read window contents');
      expect(header).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(header);
      expect(group.querySelector('[data-tool-call-id="failed"]')).not.toBeNull();
    }
  );

  it('keeps the same disclosure and reading position owner when a source message adds reasoning and another call', () => {
    const view = render(
      show([user, assistant('stable-source', [request('first')])], true, undefined, false),
      { wrapper: IntlTestWrapper }
    );
    const group = view.container.querySelector<HTMLElement>('[data-process-group]')!;
    const header = within(group).getByRole('button', { expanded: false });
    fireEvent.click(header);
    const row = group.querySelector('[data-tool-call-id="first"]');
    view.rerender(
      show(
        [
          user,
          assistant('stable-source', [
            request('first'),
            thought('Compare before the next operation.'),
            request('second'),
          ]),
        ],
        true,
        undefined,
        false
      )
    );
    expect(view.container.querySelector('[data-process-group]')).toBe(group);
    expect(group.querySelector('[data-tool-call-id="first"]')).toBe(row);
    expect(header).toHaveAttribute('aria-expanded', 'true');
  });

  it('settles stage text and every process group under one top disclosure while keeping the final reply outside', async () => {
    const records = [
      user,
      assistant('work-one', [thought('First thought.'), request('first')]),
      receipt('first'),
      assistant('stage', [{ type: 'text', text: 'A public stage update.' }]),
      assistant('work-two', [request('second')]),
      receipt('second'),
    ];
    const view = render(show(records, true), { wrapper: IntlTestWrapper });
    const groups = [...view.container.querySelectorAll<HTMLElement>('[data-process-group]')];
    fireEvent.click(within(groups[1]).getByRole('button', { expanded: false }));
    const terminal = assistant('bound-terminal', [
      {
        type: 'systemNotification',
        notificationType: 'turnTerminal',
        msg: '',
        data: {
          schema_version: 1,
          session_id: 'between-replies',
          run_id: 'run',
          source_user_message_id: user.id,
          terminal_message_id: 'bound-terminal',
          status: 'completed',
          visible_text_available: true,
          last_response_text_available: true,
          tool_action_count: 2,
          copy_artifact_ref: null,
          finished_at: '1970-01-01T00:02:01Z',
          checkpoint_id: null,
          retry_strategy: 'not_available',
        },
      },
    ]);
    view.rerender(
      show([
        ...records,
        assistant('final', [{ type: 'text', text: 'The final result.' }]),
        terminal,
      ])
    );
    const summary = await screen.findByRole('button', { name: 'Time spent 2 min 0 sec' }, { timeout: 5000 });
    expect(summary).toHaveAttribute('aria-expanded', 'false');
    for (const group of groups) expect(group).not.toBeVisible();
    expect(screen.queryByText('A public stage update.')).not.toBeInTheDocument();
    expect(screen.getByText('The final result.')).toBeVisible();
    expect(
      summary.compareDocumentPosition(screen.getByText('The final result.')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    fireEvent.click(summary);
    expect(screen.getByText('A public stage update.')).toBeVisible();
    const revealed = view.container.querySelectorAll<HTMLElement>('[data-process-group]');
    expect(revealed).toHaveLength(2);
    expect(within(revealed[1]).getByRole('button', { expanded: false })).toBeVisible();
    fireEvent.click(summary);
    expect(screen.queryByText('A public stage update.')).not.toBeInTheDocument();
  });

  it('keeps one live permission outside collapsed history and removes it on cancellation without needing a tool receipt', async () => {
    const permission = requestAcpPermission({
      sessionId: 'between-replies',
      toolCall: { toolCallId: 'first', title: 'developer__read', status: 'pending' },
      options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
    });
    const records = [
      user,
      assistant('pending-tool', [thought('Check a file.'), request('first')]),
      assistant('confirmation', [
        {
          type: 'actionRequired',
          data: {
            actionType: 'toolConfirmation',
            id: 'first',
            toolName: 'developer__read',
            arguments: { path: 'first.md' },
            availableActions: ['allow_once', 'deny_once'],
          },
        },
      ]),
    ];
    const view = render(show(records, true), { wrapper: IntlTestWrapper });
    const group = view.container.querySelector('[data-process-group]')!;
    const header = group.querySelector('.codepro-group-heading')!.closest('button')!;
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(
      group.querySelector('[data-process-approval] [data-tool-call-id="first"]')
    ).not.toBeNull();
    expect(screen.getAllByTestId('tool-approval-actions')).toHaveLength(1);
    fireEvent.click(header);
    expect(group.querySelectorAll('[data-tool-call-id="first"]')).toHaveLength(1);
    act(() => cancelAcpPermissionRequestsForSession('between-replies'));
    expect(await permission).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(group.querySelector('[data-process-approval]')).toBeNull();
    expect(screen.queryByTestId('tool-approval-actions')).toBeNull();
    expect(group.querySelectorAll('[data-tool-call-id="first"]')).toHaveLength(1);
    expect(JSON.stringify(records)).toContain('Check a file.');
  });

  it.each(['running', 'approval', 'failed'] as const)(
    'keeps reasoning independently expandable inside an expanded %s process',
    (state) => {
      if (state === 'approval')
        void requestAcpPermission({
          sessionId: 'between-replies',
          toolCall: { toolCallId: 'first', title: 'developer__read', status: 'pending' },
          options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
        });
      const records = [
        user,
        assistant('reasoning-disclosure', [thought('Detailed model reasoning.'), request('first')]),
        ...(state === 'failed' ? [receipt('first', true)] : []),
        ...(state === 'approval'
          ? [
              assistant('confirmation', [
                {
                  type: 'actionRequired',
                  data: {
                    actionType: 'toolConfirmation',
                    id: 'first',
                    toolName: 'developer__read',
                    arguments: { path: 'first.md' },
                  },
                },
              ]),
            ]
          : []),
      ];
      const original = JSON.stringify(records);
      const view = render(show(records, state !== 'failed'), { wrapper: IntlTestWrapper });
      const group = view.container.querySelector<HTMLElement>('[data-process-group]')!;
      const toggle = group
        .querySelector<HTMLButtonElement>('.codepro-group-heading')!
        .closest('button')!;
      expect(group.querySelector('.codepro-tool-group')).toBeNull();
      fireEvent.click(toggle);
      expect(group.querySelector('[data-tool-call-id="first"]')).not.toBeNull();
      expect(group.querySelectorAll('[data-tool-call-id="first"]')).toHaveLength(1);
      const thoughtToggle = within(group).getByRole('button', { name: 'Thinking', expanded: false });
      fireEvent.click(thoughtToggle);
      expect(group.querySelectorAll('.codepro-thinking-details')).toHaveLength(1);
      const detail = screen.getByText('Detailed model reasoning.');
      expect(detail).toBeVisible();
      expect(detail.closest('[data-process-group]')).toBe(group);
      expect(detail.closest('.codepro-assistant-prose')).toBeNull();
      expect(JSON.stringify(records)).toBe(original);
    }
  );

  it('keeps the entire live process collapsed and updates its heading from actual active commands', () => {
    const shell = (id: string, command: string): ToolRequestMessageContent => ({
      type: 'toolRequest',
      id,
      toolCall: { name: 'pwsh', arguments: { command } },
    });
    const first = assistant('first-command', [shell('first', 'git status --short')]);
    const renderCommands = (records: Message[], active: string[]) => (
      <ScrollFollowingContext.Provider value={false}>
        <ProgressiveMessageList
          messages={records}
          chat={{ sessionId: 'current-command' }}
          isUserMessage={(item) => item.role === 'user'}
          isStreamingMessage
          activeToolCallIds={active}
        />
      </ScrollFollowingContext.Provider>
    );
    const view = render(renderCommands([user, first], ['first']), { wrapper: IntlTestWrapper });
    const group = view.container.querySelector<HTMLElement>('[data-process-group]')!;
    const toggle = within(group).getByRole('button', { expanded: false });
    expect(toggle).toHaveTextContent('git status --short');
    expect(group.querySelector('[data-tool-call-id]')).toBeNull();
    view.rerender(
      renderCommands(
        [
          user,
          first,
          receipt('first'),
          assistant('next-command', [shell('second', 'git diff --stat')]),
        ],
        ['second']
      )
    );
    expect(view.container.querySelector('[data-process-group]')).toBe(group);
    expect(toggle).toHaveTextContent('git diff --stat');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    view.rerender(
      renderCommands(
        [
          user,
          first,
          receipt('first'),
          assistant('next-command', [shell('second', 'git diff --stat')]),
          receipt('second'),
          assistant('next-thought', [thought('Compare the changes before replying.')]),
        ],
        []
      )
    );
    expect(toggle).toHaveTextContent('Ran command git diff --stat');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(
      [...group.querySelectorAll('[data-tool-call-id]')].map((row) =>
        row.getAttribute('data-tool-call-id')
      )
    ).toEqual(['first', 'second']);
    expect(screen.getByText('Compare the changes before replying.')).toBeVisible();
  });

  it('observes committed text from the public range rather than a folded reasoning range', () => {
    const previousElectron = window.electron;
    const logger = vi.fn();
    window.electron = { ...previousElectron, logInfo: logger };
    try {
      render(
        show(
          [
            user,
            assistant('mixed-observation', [
              thought('Reasoning before the visible answer.'),
              { type: 'text', text: 'Visible answer for timing.' },
            ]),
          ],
          true
        ),
        { wrapper: IntlTestWrapper }
      );
      const observations = logger.mock.calls.flatMap(([value]) => {
        try {
          const parsed = JSON.parse(value);
          return parsed.stage === 'ui_text_committed' ? [parsed] : [];
        } catch {
          return [];
        }
      });
      expect(observations).toHaveLength(1);
      expect(observations[0].text_mounted).toBe(true);
    } finally {
      window.electron = previousElectron;
    }
  });

  it('preserves a custom renderer source message even when provider thinking is suppressed', () => {
    const original = assistant('custom', [thought('Custom renderer evidence')]);
    const renderer = vi.fn((item: Message) => <div>{item.id}</div>);
    render(
      <ProgressiveMessageList
        messages={[original]}
        chat={{ sessionId: 'custom-renderer' }}
        isUserMessage={() => false}
        renderMessage={renderer}
        suppressProviderThinking
      />,
      { wrapper: IntlTestWrapper }
    );
    expect(renderer).toHaveBeenCalledWith(original, 0);
  });

  it('keeps typed progress public when whitespace precedes it in a mixed source message', () => {
    const progress: ToolRequestMessageContent = {
      type: 'toolRequest',
      id: 'progress',
      toolCall: { name: 'codepro__publish_progress', arguments: { text: 'Comparison complete.' } },
    };
    const mixed = assistant('mixed-progress', [
      { type: 'text', text: '\n ' },
      progress,
      request('first'),
      thought('Check the remaining source.'),
    ]);
    const view = render(show([user, mixed, receipt('progress'), receipt('first')]), {
      wrapper: IntlTestWrapper,
    });
    const text = screen.getByText('Comparison complete.');
    expect(text).toBeVisible();
    expect(text.closest('[data-process-group]')).toBeNull();
    const groups = view.container.querySelectorAll<HTMLElement>('[data-process-group]');
    expect(groups).toHaveLength(1);
    fireEvent.click(within(groups[0]).getByRole('button', { expanded: false }));
    fireEvent.click(within(groups[0]).getByRole('button', { name: 'Thinking', expanded: false }));
    expect(within(groups[0]).getByText('Check the remaining source.')).toBeVisible();
  });

  it('keeps mixed-message prose and images outside ordered process ranges, with original retry identity', () => {
    const mixed = assistant('original-assistant', [
      thought('First reasoning.'),
      { type: 'text', text: 'The first finding.' },
      request('first'),
      thought('Check another source.'),
      request('second'),
      { type: 'text', text: 'The second finding.' },
      { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
      thought('Prepare the follow-up.'),
      request('third'),
    ]);
    const records = [user, mixed, receipt('first'), receipt('second'), receipt('third')];
    const original = JSON.stringify(records);
    const retry = vi.fn();
    const view = render(show(records, false, retry), { wrapper: IntlTestWrapper });
    const groups = [...view.container.querySelectorAll<HTMLElement>('[data-process-group]')];
    expect(groups).toHaveLength(3);
    for (const text of ['The first finding.', 'The second finding.']) {
      const prose = screen.getByText(text);
      expect(prose).toBeVisible();
      expect(prose.closest('[data-process-group]')).toBeNull();
    }
    expect(view.container.querySelector('img')?.closest('[data-process-group]')).toBeNull();
    fireEvent.click(within(groups[1]).getByRole('button', { expanded: false }));
    expect(
      [...groups[1].querySelectorAll('[data-tool-call-id]')].map((item) =>
        item.getAttribute('data-tool-call-id')
      )
    ).toEqual(['first', 'second']);
    fireEvent.click(within(groups[1]).getByRole('button', { name: 'Thinking', expanded: false }));
    expect(within(groups[1]).getByText('Check another source.')).toBeVisible();
    expect(view.container.querySelectorAll('.goose-message .codepro-message-actions')).toHaveLength(
      1
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledWith('source-user', 'Inspect the project.', 'retry');
    expect(JSON.stringify(records)).toBe(original);
  });

  it('joins internal batches across resolved approvals without adding a public boundary', () => {
    const approval = assistant('approval', [
      {
        type: 'actionRequired',
        data: {
          actionType: 'toolConfirmation',
          id: 'first',
          toolName: 'developer__read',
          arguments: { path: 'first.md' },
        },
      },
    ]);
    const records = [
      user,
      assistant('batch-one', [request('first')]),
      approval,
      receipt('first'),
      assistant('more-thinking', [thought('Compare both files.')]),
      assistant('batch-two', [request('second')]),
      receipt('second'),
    ];
    const view = render(show(records), { wrapper: IntlTestWrapper });
    const groups = view.container.querySelectorAll<HTMLElement>('[data-process-group]');
    expect(groups).toHaveLength(1);
    const toggle = within(groups[0]).getByRole('button', { expanded: false });
    fireEvent.click(toggle);
    fireEvent.click(within(groups[0]).getByRole('button', { name: 'Thinking', expanded: false }));
    expect(within(groups[0]).getByText('Compare both files.')).toBeVisible();
    expect(groups[0].querySelectorAll('[data-tool-call-id]')).toHaveLength(2);
  });

  it('keeps failures and unknown receipts accessible instead of hiding them behind successful history', () => {
    const view = render(
      show([
        user,
        assistant('failed', [request('first')]),
        receipt('first', true),
        assistant('unknown', [request('second')]),
        assistant('answer', [{ type: 'text', text: 'Checks remain incomplete.' }]),
      ]),
      { wrapper: IntlTestWrapper }
    );
    const history = view.container.querySelector<HTMLElement>('[data-process-group]')!;
    const toggle = within(history).getByRole('button', { expanded: false });
    expect(screen.getByText('Checks remain incomplete.')).toBeVisible();
    fireEvent.click(toggle);
    expect(view.container.querySelector('[data-tool-call-id="first"]')).toHaveAttribute(
      'data-tool-phase',
      'error'
    );
    expect(view.container.querySelector('[data-tool-call-id="second"]')).toHaveAttribute(
      'data-tool-phase',
      'unknown'
    );
    expect(screen.getByText('Checks remain incomplete.')).toBeVisible();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).not.toHaveTextContent('Failed');
    expect(toggle).not.toHaveTextContent('·');
    expect(screen.getByText('Checks remain incomplete.')).toBeVisible();
  });

  it('folds the same manually opened group when its completed operations reach a public reply', () => {
    const first = assistant('work', [request('first')]);
    const records = [user, first, receipt('first')];
    const view = render(show(records, true, undefined, false), { wrapper: IntlTestWrapper });
    const group = view.container.querySelector<HTMLElement>('[data-process-group]')!;
    const toggle = within(group).getByRole('button', { expanded: false });
    fireEvent.click(toggle);
    expect(group.querySelector('[data-tool-call-id="first"]')).not.toBeNull();
    view.rerender(
      show(
        [
          ...records,
          assistant('second-batch', [request('second')]),
          receipt('second'),
          assistant('result', [{ type: 'text', text: 'Both files checked.' }]),
        ],
        false,
        undefined,
        false
      )
    );
    expect(view.container.querySelector('[data-process-group]')).toBe(group);
    expect(group.querySelector('[data-tool-call-id="first"]')).toBeNull();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Both files checked.')).toBeVisible();
    fireEvent.click(toggle);
    expect(group.querySelector('[data-tool-call-id="first"]')).not.toBeNull();
  });

  it('lets a single completed operation fold and keeps separate user turns separate', () => {
    const nextUser = { ...user, id: 'next-user' };
    const view = render(
      show([
        user,
        assistant('one', [request('first')]),
        receipt('first'),
        nextUser,
        assistant('two', [request('second')]),
        receipt('second'),
      ]),
      { wrapper: IntlTestWrapper }
    );
    const groups = view.container.querySelectorAll<HTMLElement>('[data-process-group]');
    expect(groups).toHaveLength(2);
    for (const group of groups)
      expect(within(group).getByRole('button', { expanded: false })).toBeVisible();
  });

  it('shows one model-change disclosure for several public parts of the same source message', () => {
    const earlier = assistant('earlier', [{ type: 'text', text: 'Earlier answer.' }]);
    earlier.metadata.inference = { resolvedModel: 'provider/previous' } as NonNullable<
      Message['metadata']['inference']
    >;
    const mixed = assistant('changed', [
      { type: 'text', text: 'First finding.' },
      request('first'),
      { type: 'text', text: 'Second finding.' },
    ]);
    mixed.metadata.inference = { resolvedModel: 'provider/current' } as NonNullable<
      Message['metadata']['inference']
    >;
    render(show([user, earlier, mixed, receipt('first')]), { wrapper: IntlTestWrapper });
    expect(screen.getAllByText(/Model changed:/)).toHaveLength(1);
  });
});

it('keeps a native in-progress tool readable across a transient empty live-call list, then consumes its real receipt', async () => {
  const native: ToolRequestMessageContent = {
    type: 'toolRequest',
    id: 'lookup',
    metadata: { extensionName: 'harness', status: 'in_progress' },
    toolCall: { status: 'success', value: { name: 'glob', arguments: { pattern: 'README.md' } } },
  };
  const records = [user, assistant('lookup-message', [native])];
  const tree = (history: Message[], streaming: boolean) => (
    <ProgressiveMessageList
      messages={history}
      chat={{ sessionId: 'tool-status-race' }}
      isUserMessage={(message) => message.role === 'user'}
      isStreamingMessage={streaming}
      activeToolCallIds={[]}
    />
  );
  const view = render(tree(records, true), { wrapper: IntlTestWrapper });
  expect(screen.queryByText('Unknown status')).toBeNull();
  await waitFor(() => expect(view.container.textContent).toContain('README.md'));
  expect(screen.queryByText('Unknown status')).toBeNull();
  view.rerender(tree([...records, receipt('lookup')], false));
  expect(screen.queryByText('Unknown status')).toBeNull();
});
