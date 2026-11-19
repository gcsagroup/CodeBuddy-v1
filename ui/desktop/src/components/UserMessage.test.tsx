import { applyContentChunk } from '../acp/adapter/messages';
import { act, render, screen } from '@testing-library/react';
import { Profiler } from 'react';
import userEvent from '@testing-library/user-event';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import type { Message } from '../types/message';
import UserMessage from './UserMessage';
import ProgressiveMessageList from './ProgressiveMessageList';

describe('UserMessage', () => {
  beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); });
  afterEach(() => vi.unstubAllGlobals());
  const message: Message = {
    id: 'short-message',
    role: 'user',
    created: Date.now(),
    content: [{ type: 'text', text: '你好' }],
    metadata: { agentVisible: true, userVisible: true },
  };

  it('bounds sent text and hover preview while preserving the complete resend', async () => {
    const user = userEvent.setup();
    const text = '{"nested":"中文🙂"}\n'.repeat(24000);
    const update = vi.fn();
    const view = render(
      <UserMessage
        message={{ ...message, content: [{ type: 'text', text }] }}
        onMessageUpdate={update}
      />,
      { wrapper: IntlTestWrapper }
    );
    expect(view.container.textContent!.length).toBeLessThan(1000);
    const textBlock = screen.getByRole('button', { name: 'Open pasted text as TXT' });
    await user.hover(textBlock);
    expect((await screen.findByRole('tooltip')).querySelector('pre')!.textContent!.length).toBeLessThanOrEqual(12000);
    await user.unhover(textBlock);
    await user.click(screen.getByRole('button', { name: /Edit message/ }));
    const suffix = screen.getByRole('textbox', {
      name: 'Edit message content',
    }) as HTMLTextAreaElement;
    expect(suffix.value).toBe('');
    await user.type(suffix, '\nquestion');
    await user.click(screen.getByRole('button', { name: 'Edit and resend message' }));
    expect(update).toHaveBeenCalledWith(message.id, text + '\nquestion', 'edit');
  });

  it.each([
    'https://github.com/Panniatong/Agent-Reach分析一下和这个网址里面的是什么',
    '  中文 🙂\n[文档](https://example.com/文档?q=中文)\n`code`  ',
  ])('copies user source verbatim without HTML that changes pasted links: %s', async (text) => {
    const user = userEvent.setup();
    const copyText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const copyRichText = vi.spyOn(navigator.clipboard, 'write').mockResolvedValue(undefined);
    try {
      render(<UserMessage message={{ ...message, content: [{ type: 'text', text }] }} />, {
        wrapper: IntlTestWrapper,
      });
      await user.click(screen.getByRole('button', { name: 'Copy' }));
      expect(copyText).toHaveBeenCalledExactlyOnceWith(text);
      expect(copyRichText).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Copy' })).toHaveTextContent('Copied!');
    } finally {
      copyText.mockRestore();
      copyRichText.mockRestore();
    }
  });

  it('marks unadmitted input without offering edit-and-resend, then clears the mark on acknowledgement', () => {
    const view = render(
      <UserMessage
        message={{
          ...message,
          metadata: {
            userVisible: true,
            agentVisible: false,
            pendingDelivery: 'pending',
          },
        }}
      />,
      { wrapper: IntlTestWrapper }
    );
    expect(screen.getByRole('status')).toHaveTextContent('Waiting to send');
    expect(screen.queryByRole('button', { name: /Edit message/ })).toBeNull();
    view.rerender(<UserMessage message={message} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: /Edit message/ })).toBeVisible();
  });
  it('lets a failed request remove attachments before resending while keeping the original message intact', async () => {
    const update = vi.fn();
    const source: Message = { ...message, content: [{ type: 'text', text: 'Edit this' },
      { type: 'image', data: 'first', mimeType: 'image/png' }, { type: 'image', data: 'second', mimeType: 'image/png' }] };
    render(<UserMessage message={source} onMessageUpdate={update} />, { wrapper: IntlTestWrapper });
    await userEvent.click(screen.getByRole('button', { name: 'Edit message: Edit this' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove image 1 from this resend' }));
    await userEvent.click(screen.getByRole('button', { name: 'Edit and resend message' }));
    expect(update).toHaveBeenCalledWith(message.id, 'Edit this', 'edit', [1]);
    expect(source.content.filter(block => block.type === 'image')).toHaveLength(2);
  });

  it('renders incoming message updates without a second draft-state commit', async () => {
    const commits = vi.fn();
    const view = (text: string) => (
      <Profiler id="user-message" onRender={commits}>
        <UserMessage message={{ ...message, content: [{ type: 'text', text }] }} />
      </Profiler>
    );
    const { rerender } = render(view('initial'), { wrapper: IntlTestWrapper });
    rerender(view('received -1'));
    await act(async () => {});
    commits.mockClear();
    for (let index = 0; index < 60; index += 1) rerender(view(`received ${index}`));
    expect(commits).toHaveBeenCalledTimes(60);
    expect(screen.getByText('received 59')).toBeVisible();
  });

  it('starts editing the latest source and retains an active draft across source updates', async () => {
    const user = userEvent.setup();
    const view = (text: string) => (
      <UserMessage message={{ ...message, content: [{ type: 'text', text }] }} />
    );
    const { rerender } = render(view('initial'), { wrapper: IntlTestWrapper });
    rerender(view('latest'));
    await user.click(screen.getByRole('button', { name: 'Edit message: latest' }));
    const editor = screen.getByRole('textbox', { name: 'Edit message content' });
    expect(editor).toHaveValue('latest');
    await user.clear(editor);
    await user.type(editor, 'my draft');
    rerender(view('updated source'));
    expect(editor).toHaveValue('my draft');
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Edit message: updated source' }));
    expect(screen.getByRole('textbox', { name: 'Edit message content' })).toHaveValue(
      'updated source'
    );
  });

  it('keeps read-only conversation messages copyable without editing actions', async () => {
    const user = userEvent.setup();
    const onMessageUpdate = vi.fn();
    const copyText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const copyRichText = vi.spyOn(navigator.clipboard, 'write').mockResolvedValue(undefined);
    render(
      <ProgressiveMessageList
        messages={[message]}
        chat={{ sessionId: 'read-only-child' }}
        sessionType="code_pro"
        readOnly
        isUserMessage={(item) => item.role === 'user'}
        onMessageUpdate={onMessageUpdate}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.getByText('你好')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Edit message/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(screen.getByRole('button', { name: 'Copy' })).toHaveTextContent('Copied!');
    expect(copyText.mock.calls.length + copyRichText.mock.calls.length).toBe(1);
    expect(onMessageUpdate).not.toHaveBeenCalled();
    copyText.mockRestore();
    copyRichText.mockRestore();
  });

  it('keeps the editor free of fork actions while the session type finishes loading', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<UserMessage message={message} />, { wrapper: IntlTestWrapper });
    await user.click(screen.getByRole('button', { name: 'Edit message: 你好' }));
    expect(
      screen.queryByRole('button', { name: 'Fork session with edited message' })
    ).not.toBeInTheDocument();
    rerender(<UserMessage message={message} sessionType="user" />);
    expect(
      screen.queryByRole('button', { name: 'Fork session with edited message' })
    ).not.toBeInTheDocument();
    rerender(<UserMessage message={message} sessionType="code_pro" />);
    expect(
      screen.queryByRole('button', { name: 'Fork session with edited message' })
    ).not.toBeInTheDocument();
  });

  it('keeps edit and copy actions on one line for a short message', () => {
    render(<UserMessage message={message} />, { wrapper: IntlTestWrapper });

    const editButton = screen.getByRole('button', { name: 'Edit message: 你好' });
    const copyButton = screen.getByRole('button', { name: 'Copy' });
    const actionBar = editButton.parentElement;

    expect(actionBar).toHaveClass('w-max', 'whitespace-nowrap');
    expect(editButton).toHaveClass('shrink-0', 'whitespace-nowrap');
    expect(copyButton).toHaveClass('shrink-0', 'whitespace-nowrap');
  });

  it('does not write original or edited message content to renderer logs', async () => {
    const user = userEvent.setup();
    const logInfo = vi.fn();
    Object.assign(window.electron, { logInfo });
    render(<UserMessage message={message} />, { wrapper: IntlTestWrapper });

    await user.click(screen.getByRole('button', { name: 'Edit message: 你好' }));
    const editor = screen.getByRole('textbox', { name: 'Edit message content' });
    await user.clear(editor);
    await user.type(editor, 'TOP_SECRET edited body');
    await user.keyboard('{Escape}');

    const logs = logInfo.mock.calls.flat().join('\n');
    expect(logs).not.toMatch(/你好|TOP_SECRET|edited body|Content changed|Entering edit mode/);
  });

  it('uses the same edit-and-resend action for keyboard and button submission', async () => {
    const user = userEvent.setup();
    const onMessageUpdate = vi.fn();
    const { rerender } = render(
      <UserMessage message={message} onMessageUpdate={onMessageUpdate} sessionType="user" />,
      { wrapper: IntlTestWrapper }
    );

    await user.click(screen.getByRole('button', { name: 'Edit message: 你好' }));
    const editor = screen.getByRole('textbox', { name: 'Edit message content' });
    await user.clear(editor);
    await user.type(editor, '编辑重发');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onMessageUpdate).toHaveBeenLastCalledWith('short-message', '编辑重发', 'edit');

    rerender(
      <UserMessage message={message} onMessageUpdate={onMessageUpdate} sessionType="user" />
    );
    await user.click(screen.getByRole('button', { name: 'Edit message: 你好' }));
    const inPlaceEditor = screen.getByRole('textbox', { name: 'Edit message content' });
    await user.clear(inPlaceEditor);
    await user.type(inPlaceEditor, '原地重发');
    await user.click(screen.getByRole('button', { name: 'Edit and resend message' }));
    expect(onMessageUpdate).toHaveBeenLastCalledWith('short-message', '原地重发', 'edit');
  });

  it('resends CodePro edits in place with the same keyboard shortcut', async () => {
    const user = userEvent.setup();
    const onMessageUpdate = vi.fn();
    render(
      <UserMessage message={message} onMessageUpdate={onMessageUpdate} sessionType="code_pro" />,
      { wrapper: IntlTestWrapper }
    );
    await user.click(screen.getByRole('button', { name: 'Edit message: 你好' }));
    const editor = screen.getByRole('textbox', { name: 'Edit message content' });
    await user.clear(editor);
    await user.type(editor, 'Keep this draft');
    expect(
      screen.queryByRole('button', { name: 'Fork session with edited message' })
    ).not.toBeInTheDocument();
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onMessageUpdate).toHaveBeenCalledWith('short-message', 'Keep this draft', 'edit');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('locks edits across all turns while running and retains an open draft until idle', async () => {
    const user = userEvent.setup();
    const onMessageUpdate = vi.fn();
    const messages: Message[] = [
      message,
      {
        ...message,
        id: 'previous-answer',
        role: 'assistant',
        created: message.created + 1,
        content: [{ type: 'text', text: 'Previous answer' }],
      },
      {
        ...message,
        id: 'next-query',
        created: message.created + 2,
        content: [{ type: 'text', text: 'Next question' }],
      },
    ];
    const view = (busy: boolean) => (
      <ProgressiveMessageList
        messages={messages}
        chat={{ sessionId: 'edit-boundary' }}
        isUserMessage={(item) => item.role === 'user'}
        isStreamingMessage={busy}
        messageEditingDisabled={busy}
        onMessageUpdate={onMessageUpdate}
      />
    );
    const { rerender } = render(view(false), { wrapper: IntlTestWrapper });
    expect(screen.getAllByRole('button', { name: /^Edit message:/ })).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Edit message: 你好' }));
    await user.clear(screen.getByRole('textbox', { name: 'Edit message content' }));
    await user.type(screen.getByRole('textbox', { name: 'Edit message content' }), 'Retain draft');

    rerender(view(true));
    expect(screen.queryByRole('button', { name: /^Edit message:/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Edit message content' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Copy' }).length).toBeGreaterThan(0);
    expect(onMessageUpdate).not.toHaveBeenCalled();

    rerender(view(false));
    expect(screen.getByRole('textbox', { name: 'Edit message content' })).toHaveValue(
      'Retain draft'
    );
    await user.click(screen.getByRole('button', { name: 'Edit and resend message' }));
    expect(onMessageUpdate).toHaveBeenCalledWith('short-message', 'Retain draft', 'edit');
  });
});

it('renders a native schedule delivery as a collapsed task line rather than an editable user query', () => {
  const state = { messages: [] as Message[], localSteerTextByMessageId: new Map<string, string>() };
  applyContentChunk(state, 'user', {
    sessionUpdate: 'user_message_chunk',
    content: { type: 'text', text: 'NATIVE_REMINDER_ONLY' },
    messageId: 'scheduled-source',
    _meta: { goose: { messageId: 'scheduled-source', created: 1793336017, scheduled: true } },
  });
  render(<UserMessage message={state.messages[0]} />, { wrapper: IntlTestWrapper });
  expect(screen.getByText('Automation tasks')).toBeVisible();
  expect(screen.getByText('NATIVE_REMINDER_ONLY')).not.toBeVisible();
  expect(screen.queryByRole('button', { name: /Edit message/ })).toBeNull();
  const manual = {
    messages: [] as Message[],
    localSteerTextByMessageId: new Map<string, string>(),
  };
  applyContentChunk(manual, 'user', {
    sessionUpdate: 'user_message_chunk',
    content: { type: 'text', text: 'Automation tasks' },
  });
  expect(manual.messages[0].metadata.scheduled).toBeUndefined();
});
